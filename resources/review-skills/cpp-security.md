---
id: cpp-security
name: C and C++
category: security
appliesTo: ["**/*.c", "**/*.cc", "**/*.cpp", "**/*.cxx", "**/*.c++", "**/*.h", "**/*.hh", "**/*.hpp", "**/*.hxx", "**/*.ipp", "**/*.inl", "**/*.ixx", "**/*.cppm"]
references: SEI CERT C and C++ Coding Standards; C++ Core Guidelines (bounds, lifetime, resource safety); Microsoft SDL banned function calls; CWE-787, CWE-125, CWE-416, CWE-415, CWE-476, CWE-190, CWE-134, CWE-362, CWE-367
---
C and C++ APIs for the general sinks, and memory-safety pitfalls:
- Writes or reads past a buffer (CWE-787, CWE-125): memcpy, memmove, strcpy, strcat, sprintf, gets, scanf("%s"), array indexing or pointer arithmetic whose length comes from input or an unchecked size; prefer bounded or std:: alternatives (std::string, std::span, snprintf with the real size).
- Integer overflow, truncation or signedness errors in a size, count or allocation (CWE-190): size * count passed to malloc/new, int to size_t conversions, negative lengths, a bounds check that itself overflows (offset + length > size).
- Lifetime errors: use after free or delete (CWE-416), double free (CWE-415), a pointer, reference, iterator or std::string_view kept past the object or container it refers to (invalidated by push_back, erase, a temporary), a lambda capturing a local by reference that outlives it.
- Null dereference of a result that can fail (CWE-476): malloc, fopen, dynamic_cast to a pointer, lookups returning nullptr.
- Format strings from input (CWE-134): printf-family calls whose format argument is not a literal.
- Manual new/delete or malloc/free where ownership is unclear; prefer RAII (std::unique_ptr, std::vector). A missing virtual destructor on a polymorphic base deleted through a base pointer.
- Uninitialized variables or struct members read before being set; memset/memcpy on non-trivial types.
- Races (CWE-362): shared data touched from several threads without a mutex or atomic; check-then-use on files (CWE-367) with access() then open().
- system(), popen() or exec* with a command built from input; reading environment variables or paths into fixed-size buffers.
- Undefined behavior the optimizer can exploit: signed overflow, shifts past the width, strict-aliasing casts, reading inactive union members.

Cite the call or expression and where its size, pointer or input comes from.
