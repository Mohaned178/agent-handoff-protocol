Write a JavaScript function `parseDuration(text)` that turns a duration such as "1d 2h 30m 15s" into a number of seconds. The units are d (86400 seconds), h (3600), m (60) and s (1); each may appear at most once, in that order from largest to smallest, and separated by spaces or not. At least one must be present. It throws an Error for anything else, such as an empty string, an unknown unit, a unit twice or out of order, or a negative number.

Reply with one ```js code block holding an ES module that exports `parseDuration` as a named export. Add no tests and no usage examples.
