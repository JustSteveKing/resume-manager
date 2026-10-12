import { useState } from "react";
import { describePdf } from "../../export/describe.ts";
import { exportResume } from "../../export/index.ts";
import {
  extractJob, generateTailored, jobCoverage, researchCompany, saveApplication, tailorVariant,
  type JobPosting, type Tailored,
} from "../../job.ts";
import { loadVariant, saveVariant, variantSlug, type Variant } from "../../variants.ts";
import { openPath } from "../actions.ts";
import { Form, type FormField } from "../form.tsx";
import { useKeys, useStore } from "../store.tsx";
import { C, Hints, Line, Pane, wrap } from "../ui.tsx";

interface Req {
  url?: string;
  base: string;
  write: boolean;
  research: boolean;
}

interface Outcome {
  job: JobPosting;
  cov: ReturnType<typeof jobCoverage>;
  name: string;
  variant: Variant;
  tailored?: Tailored;
  files: string[];
  pdf?: string;
  pdfReport?: string[];
}

export function TailorView(props: { active: boolean; width: number; height: number; onBack: () => void }) {
  const store = useStore();
  const [req, setReq] = useState<Req>({ base: "", write: true, research: false });
  const [out, setOut] = useState<Outcome | null>(null);
  const [scroll, setScroll] = useState(0);

  const fields: FormField[] = [
    { key: "url", label: "Job posting URL", kind: "text", required: true, validate: (s) => (URL.canParse(s) ? undefined : "Enter a full URL including https://") },
    { key: "base", label: "Start from", kind: "choice", options: [{ value: "", label: "Full resume" }, ...store.variants.map((v) => ({ value: v, label: v }))] },
    { key: "write", label: "Cover letter", kind: "bool", hint: "Tailored headline, summary and cover letter (Tabstack generate)" },
    { key: "research", label: "Research company", kind: "bool", hint: "Tabstack Research, about $2 per run. You'll be asked to confirm" },
  ];

  async function run() {
    if (!req.url) return store.flash("Enter the job posting URL first", "warn");
    const url = req.url;
    if (req.research && !(await store.confirm("Company research costs about $2 per run. Continue?"))) return;

    const result = await store.run("Tailoring", async (progress) => {
      progress("extracting job posting");
      const job = await extractJob(url);
      const cov = jobCoverage(store.resume, job);
      const variant = tailorVariant(job, url, req.base ? await loadVariant(req.base) : {});
      let name = variantSlug([job.company, job.title].filter(Boolean).join(" ") || "tailored");
      if (store.variants.includes(name)) name = `${name}-${new Date().toISOString().slice(0, 10)}`;

      let tailored: Tailored | undefined;
      if (req.write) {
        progress("writing headline, summary and cover letter");
        try {
          tailored = await generateTailored(url, store.resume, variant, job);
          variant.basics = { label: tailored.headline, summary: tailored.summary };
        } catch (e) {
          store.flash(`Cover letter failed: ${e instanceof Error ? e.message : e}`, "warn");
        }
      }
      let research;
      if (req.research) {
        try {
          research = await researchCompany(job, (m) => progress(`research: ${m}`));
        } catch (e) {
          store.flash(`Research failed: ${e instanceof Error ? e.message : e}`, "warn");
        }
      }
      await saveVariant(name, variant);
      const files = await saveApplication(name, { url, job, cov, tailored, research });
      return { job, cov, name, variant, tailored, files: [`variants/${name}.json`, ...files] } satisfies Outcome;
    });
    if (!result) return;
    await store.reloadVariants();
    setOut(result);
    setScroll(0);
    store.flash(`Saved variant ${result.name}. Press p to export the PDF.`, "ok");
  }

  async function exportPdf() {
    if (!out) return;
    const res = await store.run("Rendering tailored PDF", (progress) =>
      exportResume({ resume: store.resume, variant: out.variant, variantName: out.name, formats: ["pdf", "text"], ats: true, progress }),
    );
    const pdf = res?.pdfs[0];
    if (!pdf) return;
    setOut({ ...out, pdf: pdf.file, pdfReport: describePdf(pdf) });
    openPath(pdf.file);
  }

  useKeys(props.active, (key) => {
    if (key.name === "r") run();
    else if (key.name === "p") exportPdf();
    else if (key.name === "o" && out?.pdf) openPath(out.pdf);
    else if (key.name === "pagedown" || key.name === "]") setScroll((s) => s + 5);
    else if (key.name === "pageup" || key.name === "[") setScroll((s) => Math.max(0, s - 5));
  });

  const w = props.width - 4;
  const formH = fields.length + 8;
  const resultH = props.height - 2 - formH - 1;

  const lines: { text: string; fg?: string }[] = [];
  if (out) {
    const { job, cov } = out;
    lines.push({ text: [job.title, job.company].filter(Boolean).join(" @ ") || "Job posting", fg: C.accent });
    if (job.location) lines.push({ text: job.location, fg: C.dim });
    lines.push({ text: `Keyword coverage ${Math.round(cov.ratio * 100)}%`, fg: cov.ratio >= 0.7 ? C.ok : C.warn });
    wrap(`✔ ${cov.covered.join(", ") || "none"}`, w).forEach((t) => lines.push({ text: t, fg: C.ok }));
    wrap(`✖ ${cov.missing.join(", ") || "none"}`, w).forEach((t) => lines.push({ text: t, fg: C.err }));
    if (cov.missing.length) lines.push({ text: "Missing keywords you genuinely have? Add them to highlights or Skills, then re-run.", fg: C.dim });
    if (out.tailored) {
      lines.push({ text: "" }, { text: out.tailored.headline, fg: C.accent });
      wrap(out.tailored.summary, w).forEach((t) => lines.push({ text: t }));
    }
    lines.push({ text: "" });
    out.files.forEach((f) => lines.push({ text: `wrote ${f}`, fg: C.dim }));
    out.pdfReport?.forEach((l) => lines.push({ text: l, fg: l.includes("✖") ? C.warn : C.ok }));
  } else {
    wrap("Paste a job posting URL and press r. Tabstack extracts the requirements and keywords, you get a coverage report, and a tailored variant (ranked by the posting's keywords, fitted to 2 pages) is saved with a job report and optional cover letter in applications/.", w).forEach((t) =>
      lines.push({ text: t, fg: C.dim }),
    );
  }
  const shown = lines.slice(Math.min(scroll, Math.max(0, lines.length - resultH)), Math.min(scroll, Math.max(0, lines.length - resultH)) + resultH);

  return (
    <Pane title="Tailor to a job · Tabstack" active={props.active} width={props.width}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
        <Form
          fields={fields}
          value={req}
          onChange={(fn) => {
            const next = { ...req };
            fn(next);
            setReq(next);
          }}
          active={props.active}
          width={w}
          height={formH}
          onBack={props.onBack}
        />
        <box flexDirection="column" height={resultH} border={["top"]} borderColor={C.border}>
          {shown.map((l, i) => (
            <Line key={i} text={l.text} fg={l.fg} />
          ))}
        </box>
        <Hints keys={[["r", "run"], ["p", "export PDF"], ["o", "open PDF"], ["[ ]", "scroll"], ["esc", "back"]]} />
      </box>
    </Pane>
  );
}
