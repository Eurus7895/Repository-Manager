---
id: clean-code
name: Clean code
category: quality
appliesTo: ["**/*.py", "**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.java", "**/*.kt", "**/*.cs", "**/*.go", "**/*.rb", "**/*.php", "**/*.rs", "**/*.c", "**/*.cc", "**/*.cpp", "**/*.cxx", "**/*.h", "**/*.hh", "**/*.hpp", "**/*.hxx", "**/*.swift", "**/*.scala", "**/*.sh", "**/*.ps1"]
references: Google Engineering Practices, "What to look for in a code review" (design, functionality, complexity, tests, naming, comments, consistency)
---
Report a maintainability problem only when a reviewer would ask for a change, and cite the lines. Use severity medium for problems likely to cause bugs and low for the rest; never high or critical.

Look for:
- Complexity: functions that do several unrelated things, deep nesting, long parameter lists, or logic that can be simplified without changing behavior.
- Duplication: the same logic copied in several places where one helper would do; constants repeated instead of named.
- Naming: names that mislead about what a value holds or a function does, or that need a comment to be understood.
- Error handling: errors swallowed, logged and ignored, or returned as magic values; resources not closed on the error path.
- Dead or unreachable code, unused parameters and variables, commented-out code left behind.
- Comments that contradict the code, or explain what instead of why where the why is not obvious.
- Tests: changed behavior without a test, tests that assert nothing meaningful, or tests coupled to implementation details.
- Consistency: code that ignores a pattern the surrounding code follows (structure, error handling, naming), without a reason.

Do not report formatting a formatter would fix, personal style preferences, or speculative improvements. Suggest the smallest change that fixes the problem.
