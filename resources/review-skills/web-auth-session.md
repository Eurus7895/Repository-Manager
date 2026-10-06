---
id: web-auth-session
name: Authentication, authorization and sessions
category: security
appliesTo: ["**/routes/**", "**/controllers/**", "**/handlers/**", "**/api/**", "**/resolvers/**", "**/middleware/**", "**/auth/**", "**/*auth*.*", "**/*session*.*", "**/*login*.*", "**/*Controller.*", "**/*Resource.java", "**/route.ts", "**/route.js", "**/urls.py", "**/views.py", "**/app.py", "**/server.*"]
references: OWASP ASVS 5.0 (authentication, session management, authorization chapters); CWE-306, CWE-639, CWE-862, CWE-863, CWE-352, CWE-384, CWE-307, CWE-204, CWE-640, CWE-347
---
For each endpoint, handler, resolver or job that reads or changes data:
- Is the caller authenticated before anything else runs? Look for routes added without the middleware or decorator the others use (CWE-306).
- Is the caller allowed to act on this specific object? An id taken from the request must be checked against the caller's ownership or role, not only "logged in" (CWE-639, CWE-862, CWE-863).
- Are authorization checks on the server, in one place, and failing closed? Client-side checks or hidden fields do not count.
- Requests that change state from a browser session need a CSRF token, or cookies with SameSite=Lax or Strict and no state change on GET (CWE-352).
- Sessions: a new session id after login (CWE-384); Secure, HttpOnly and SameSite cookie flags; expiry, and logout that ends the session on the server.
- Login and recovery: rate limiting or lockout (CWE-307), the same response for unknown users and wrong passwords (CWE-204), reset tokens that are single-use and expire (CWE-640). Password hashing is in the secrets and cryptography skill.
- JWT and API tokens: the signature and algorithm are verified, "none" is rejected, audience and expiry are checked (CWE-347).

Report a missing check only when you can cite the handler and show where comparable handlers have the check, or that no check exists on the path.
