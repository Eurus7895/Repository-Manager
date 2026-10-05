---
id: javascript-security
name: JavaScript and TypeScript
category: security
appliesTo: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx", "**/*.ts", "**/*.tsx", "**/*.vue", "**/*.svelte"]
references: Amazon Q / CodeGuru detector library, JavaScript and TypeScript security categories; OWASP ASVS 5.0; CWE-1321, CWE-79, CWE-601, CWE-1333
---
JavaScript and TypeScript specifics, in addition to the general sinks:
- Prototype pollution: merging or assigning request JSON into objects with Object.assign, spread or deep-merge helpers without blocking __proto__, constructor and prototype keys (CWE-1321).
- DOM XSS: innerHTML, outerHTML, insertAdjacentHTML, document.write, jQuery html(), React dangerouslySetInnerHTML, Vue v-html with data that is not sanitized (CWE-79).
- Open redirects: res.redirect, location.href or window.open with a URL from the request (CWE-601).
- Regular expressions built from input or with nested quantifiers on input (ReDoS, CWE-1333).
- child_process exec/execSync with a string; spawn with shell: true.
- Express apps without helmet-style headers where the code sets headers itself; CORS with origin: true or * together with credentials.
- Webview, Electron or browser-extension code: nodeIntegration, contextIsolation: false, postMessage handlers that do not check the origin, CSP with unsafe-inline or unsafe-eval.
- Secrets or internal URLs bundled into client-side code or source maps.
