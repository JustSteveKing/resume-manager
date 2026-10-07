// Never touch the real ~/.config/resume-manager from tests.
process.env.RESUME_CONFIG_DIR ??= `${require("node:os").tmpdir()}/rm-test-config-${process.pid}`;

// OpenTUI tests drive React through a mock terminal, not act(); silence the act() warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

// Keep API caches out of the repo during tests.
process.env.RESUME_CACHE_DIR ??= `${require("node:os").tmpdir()}/rm-test-cache-${process.pid}`;
process.env.RESUME_APPLICATIONS_DIR ??= `${require("node:os").tmpdir()}/rm-test-apps-${process.pid}`;
process.env.RESUME_PREVIEW ??= "text"; // TUI tests: no Chrome-backed page preview unless a test asks for it
process.env.RESUME_SKIP_DOCTOR ??= "1"; // the startup doctor spawns git/which; not needed in TUI tests
