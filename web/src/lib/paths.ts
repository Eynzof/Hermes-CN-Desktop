// 跨平台路径展示工具。把用户主目录前缀缩短为 `~`，便于在 UI 里展示而不暴露
// 完整本机路径；原始 path 仍应通过 title / 详情查看。
//
// 支持三种主目录布局：
//   - macOS:   /Users/<name>/<rest>
//   - Linux:   /home/<name>/<rest>
//   - Windows: C:\Users\<name>\<rest>
//
// 仅当主目录下还有子路径时才缩短（与既有行为一致）；否则原样返回。

const WINDOWS_HOME = /^[a-zA-Z]:\\Users\\[^\\]+\\(.+)$/;
const POSIX_HOME = /^\/(?:Users|home)\/[^/]+\/(.+)$/;

export function shortenPath(path: string): string {
  if (!path) return "—";

  const win = WINDOWS_HOME.exec(path);
  if (win) return `~\\${win[1]}`;

  const posix = POSIX_HOME.exec(path);
  if (posix) return `~/${posix[1]}`;

  return path;
}
