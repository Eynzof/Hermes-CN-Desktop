// Context references facade.
//
// Re-exports the parser, resolver, and expander for `@file`, `@folder`,
// `@diff`, `@staged`, `@git:N`, and `@url` mentions. The resolver bridges
// to Rust Tauri commands for filesystem / git / network access.

export * from "./types";
export * from "./parse";
export * from "./resolve";
export * from "./expand";
