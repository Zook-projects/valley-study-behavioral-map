"""
context_builders/ — One module per topic, each exporting a `build_{topic}()`
function that returns a context envelope (per scripts/context_schema.py).

Each builder reads the cached extracts populated by the fetch-context-*.py
scripts and composes a wire-format envelope for build-context.py to write.
"""
