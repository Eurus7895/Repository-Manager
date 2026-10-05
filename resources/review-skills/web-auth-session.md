---
id: web-auth-session
name: Authentication, authorization and sessions
category: security
appliesTo: ["**/routes/**", "**/controllers/**", "**/handlers/**", "**/api/**", "**/views/**", "**/middleware/**", "**/auth/**", "**/*auth*.*", "**/*session*.*", "**/*login*.*", "**/urls.py", "**/views.py", "**/app.py", "**/server.*", "**/*Controller.*"]
references: OWASP ASVS 5.0 (authentication, session management, authorization chapters); CWE-862, CWE-863, CWE-287, CWE-306, CWE-352, CWE-384, CWE-639
---
For each endpoint, handler or job that reads or changes data:
- Is the caller authenticated before anything else runs? Look for routes added without the middleware or decorator the others use (CWE-306).
- Is the caller allowed to act on this specific object? An id taken from the request must be checked against the caller's ownership or role, not only "logged in" (CWE-639, CWE-862, CWE-863).
- Are authorization checks done on the server, in one place, and failing closed? Client-side checks or hidden fields do not count.
- State-changing requests from a browser need CSRF protection or same-site cookies with a non-simple request (CWE-352).
- Sessions: a new session id after login (CWE-384), Secure, HttpOnly and SameSite cookie flags, expiry and logout that invalidates server-side state.
- Credentials: passwords hashed with a slow salted algorithm (bcrypt, scrypt, Argon2, PBKDF2), rate limiting or lockout on login, no user enumeration in error messages, reset tokens single-use and time-limited (CWE-287).
- JWT and API tokens: the signature and algorithm are verified, "none" is rejected, audience and expiry are checked.

Report a missing check only when you can cite the handler and show where comparable handlers have the check, or that no check exists on the path.
