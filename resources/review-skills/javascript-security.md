---
id: javascript-security
name: JavaScript and TypeScript
category: security
appliesTo: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx", "**/*.ts", "**/*.tsx", "**/*.vue", "**/*.svelte"]
references: Amazon Q / CodeGuru detector library, JavaScript and TypeScript security categories; OWASP ASVS 5.0; CWE-1321, CWE-79, CWE-601, CWE-1333, CWE-78, CWE-942
---
JavaScript and TypeScript APIs for the general sinks, and JS-only pitfalls:
- Prototype pollution: request JSON merged or assigned into objects (Object.assign, spread into existing objects, deep-merge helpers, obj[key] = value with a key from input) without blocking __proto__, constructor and prototype (CWE-1321).
- DOM XSS: innerHTML, outerHTML, insertAdjacentHTML, document.write, jQuery html(), React dangerouslySetInnerHTML, Vue v-html, Svelte {@html}, with data that is not sanitized (CWE-79).
- Code evaluation: eval, new Function, setTimeout or setInterval with a string, vm.runInContext on input.
- Commands: child_process exec or execSync with a string built from input; spawn or execFile with shell: true (CWE-78).
- Open redirects: res.redirect, location.href, location.assign or window.open with a URL from the request (CWE-601).
- Regular expressions built from input, or with nested quantifiers matched against input (ReDoS, CWE-1333).
- CORS that reflects the request's Origin (origin: true, or echoing the header) while allowing credentials (CWE-942).
- Webview, Electron or browser-extension code: nodeIntegration: true, contextIsolation: false, message handlers that do not check event.origin, CSP with unsafe-inline or unsafe-eval.
- Secrets or internal URLs bundled into client-side code or source maps.

Cite the call and the input that reaches it.
