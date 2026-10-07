import type { Intent } from "../commands.ts";
import { Basics, type Resume } from "../../schema.ts";
import { fieldsFor } from "../../sections.ts";
import { rewriteFlow } from "../flows.ts";
import { Form, type FormField } from "../form.tsx";
import { useStore } from "../store.tsx";
import { Pane } from "../ui.tsx";
import { toFormFields } from "./section.tsx";

type Loc = NonNullable<Resume["basics"]["location"]>;

const location = (key: keyof Loc, label: string, hint?: string): FormField => ({
  key: `location.${key}`,
  label,
  kind: "text",
  hint,
  get: (b: Resume["basics"]) => b.location?.[key],
  set: (b: Resume["basics"], v) => {
    b.location ??= {};
    if (v === undefined) delete b.location[key];
    else b.location[key] = v as string;
  },
});

const FIELDS: FormField[] = [
  ...toFormFields(fieldsFor(Basics)),
  location("city", "City"),
  location("region", "Region", "State, province or county"),
  location("countryCode", "Country code", "ISO 3166-1 alpha-2, e.g. GB, US"),
  location("postalCode", "Postal code"),
  location("address", "Address"),
];

export function BasicsView(props: { active: boolean; width: number; height: number; onBack: () => void; intent?: Intent }) {
  const store = useStore();
  return (
    <Pane title="Basics" active={props.active} width={props.width}>
      <box paddingLeft={1} paddingRight={1}>
        <Form
          fields={FIELDS}
          value={store.resume.basics}
          onChange={(fn, label) => store.update((r) => fn(r.basics), label)}
          active={props.active}
          width={props.width - 4}
          height={props.height - 2}
          onBack={props.onBack}
          autoEdit={props.intent?.action === "edit" ? "name" : undefined}
          onRewrite={(field, text) => (field.key === "summary" || field.key === "label" ? rewriteFlow(store, text, "summary") : Promise.resolve(null))}
        />
      </box>
    </Pane>
  );
}
