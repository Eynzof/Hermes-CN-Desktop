//! Windows Git Bash compatibility scanner — Rust port of kimi-agent's
//! `src/kimix/tools/file/bash/bash_fix.py` (canonical implementation lives in
//! `bin/kimix_native/_shell_compat.py`).
//!
//! Git for Windows ships a substantial POSIX userland, but a few command names
//! commonly emitted for Linux or macOS are absent even though an equivalent is
//! already available.  This module rewrites only verified, behaviorally
//! compatible command words.  It does not install software and deliberately
//! leaves commands without a faithful equivalent untouched.
//!
//! Windows-style backslash paths (`D:\repo\src`, `\\server\share`,
//! `~\Desktop`, `.\build`) — whether used as arguments, redirection targets,
//! or as the command word itself (`C:\tools\rg.exe`) — are rewritten to the
//! forward-slash spellings Git Bash understands, and the cmd.exe-only
//! `cd /d <path>` form loses its flag (`cd` accepts a single argument in
//! Bash).  Git Bash virtual POSIX absolute paths are rewritten to the native
//! spellings native Windows executables can resolve: `/tmp/x` becomes the real
//! Windows temp directory and `/c/x`/`/d/x` become `C:/x`/`D:/x`.
//!
//! A redundant leading shell invocation — `bash cd /c/dev/x && ...` or
//! `bash -c 'cd C:\x && rev'` — is unwrapped (and the `-c` inline script is
//! scanned for fallbacks and paths) because the terminal already runs the whole
//! string via bash.  Under an active command wrapper (`env`/`nohup`/`timeout`/
//! ...) the shell word is an operand of that wrapper, so `bash -c '<script>'`
//! keeps its shape and only the inline script is fixed in place.
//!
//! Command wrappers whose operand is itself a command are scanned as command
//! contexts so missing POSIX commands behind them get their Git Bash fallback:
//! `timeout` (its one DURATION operand is consumed first), `stdbuf`, `nice`,
//! and `xargs`, plus the fallback wrappers `gtimeout` and `watch`.  Fallback
//! definitions are exported (`export -f`) so nested shells inherit them.
//!
//! Rewrites are conservative: the unquoted word must look unambiguously like a
//! Windows path, so quoted data, tool-level escape sequences, short ambiguous
//! words such as `a\nb`, and single-segment relative paths such as `foo\bar`
//! are preserved byte-for-byte.  The scanner is shell-aware: quoted text,
//! comments, heredoc and here-string bodies, assignments, case patterns, and
//! ordinary arguments are data, not commands.  Nested command substitutions
//! and process substitutions are scanned as their own command contexts.
//!
//! The module also ports `_process_unquoted` from `bash_tool.py`: it converts
//! *unquoted* backslashes to forward slashes (descending into `$(...)` and
//! backtick substitutions) so commands sent through the desktop terminal
//! behave the same as through the Python Bash tool.

use std::collections::HashMap;
use std::sync::LazyLock;

// =====================================================================
// Data tables (auto-generated from kimi-agent `_shell_compat.py`).
// =====================================================================

pub const FALLBACK_BODIES: &[(&str, &str)] = &[
    ("chdir", r#"cd -- "$@""#),
    ("cls", r"clear"),
    ("column", r#"local __kimix_sep='DEFAULT'; while (( $# )); do case $1 in -t) shift;; -s) __kimix_sep=$2; shift 2;; -s?*) __kimix_sep=${1#-s}; shift;; -*) printf '%s\n' "column: unsupported option for perl fallback: $1" >&2; return 1;; *) break;; esac; done; perl -e 'my $sep = shift @ARGV; $sep = qr/\s+/ if $sep eq "DEFAULT"; my @rows; my @max; while (<>) { chomp; my @c = split $sep; push @rows, \@c; for my $i (0..$#c) { $max[$i] = length($c[$i]) if !defined $max[$i] || length($c[$i]) > $max[$i]; } } for my $r (@rows) { print join("  ", map { sprintf("%-*s", $max[$_]//0, $r->[$_]) } 0..$#$r), "\n"; }' "$__kimix_sep" "$@""#),
    ("copy", r#"if [[ $# -lt 2 ]]; then printf '%s\n' 'copy: missing source or destination' >&2; return 1; fi; cp -R -- "$@""#),
    ("del", r#"rm -- "$@""#),
    ("erase", r#"rm -- "$@""#),
    ("fc", r#"diff "$@""#),
    ("findstr", r#"grep "$@""#),
    ("gawk", r#"awk "$@""#),
    ("gcat", r#"cat "$@""#),
    ("gcomm", r#"comm "$@""#),
    ("gcp", r#"cp "$@""#),
    ("gcut", r#"cut "$@""#),
    ("gdate", r#"date "$@""#),
    ("gdf", r#"df "$@""#),
    ("gdu", r#"du "$@""#),
    ("gegrep", r#"egrep "$@""#),
    ("gfgrep", r#"fgrep "$@""#),
    ("gfind", r#"find "$@""#),
    ("ggrep", r#"grep "$@""#),
    ("ghead", r#"head "$@""#),
    ("gjoin", r#"join "$@""#),
    ("gln", r#"ln "$@""#),
    ("gls", r#"ls "$@""#),
    ("gmake", r#"make "$@""#),
    ("gmkdir", r#"mkdir "$@""#),
    ("gmv", r#"mv "$@""#),
    ("gpaste", r#"paste "$@""#),
    ("greadlink", r#"readlink "$@""#),
    ("grealpath", r#"realpath "$@""#),
    ("grm", r#"rm "$@""#),
    ("grmdir", r#"rmdir "$@""#),
    ("gsed", r#"sed "$@""#),
    ("gseq", r#"seq "$@""#),
    ("gshuf", r#"shuf "$@""#),
    ("gsort", r#"sort "$@""#),
    ("gsplit", r#"split "$@""#),
    ("gstat", r#"stat "$@""#),
    ("gtail", r#"tail "$@""#),
    ("gtar", r#"tar "$@""#),
    ("gtimeout", r#"timeout "$@""#),
    ("gtr", r#"tr "$@""#),
    ("guniq", r#"uniq "$@""#),
    ("gwc", r#"wc "$@""#),
    ("gxargs", r#"xargs "$@""#),
    ("killall", r"if [[ $# -eq 0 ]]; then printf '%s\n' 'killall: missing process name' >&2; return 1; fi; __KIMIX_NAME=$1 powershell.exe -NoProfile -NonInteractive -Command '$procs = Get-Process | Where-Object { $_.Name -eq $env:__KIMIX_NAME }; if ($procs) { $procs | Stop-Process -Force; exit 0 } else { exit 1 }'"),
    ("md", r#"mkdir -p -- "$@""#),
    ("mklink", r#"local __kimix_hard=0 __kimix_link='' __kimix_target=''; while (( $# )); do case $1 in /D|/d|/J|/j) shift;; /H|/h) __kimix_hard=1; shift;; *) if [[ -z $__kimix_link ]]; then __kimix_link=$1; elif [[ -z $__kimix_target ]]; then __kimix_target=$1; else printf '%s\n' 'mklink: too many arguments' >&2; return 1; fi; shift;; esac; done; if [[ -z $__kimix_link || -z $__kimix_target ]]; then printf '%s\n' 'mklink: missing link name or target' >&2; return 1; fi; if (( __kimix_hard )); then ln -f -- "$__kimix_target" "$__kimix_link"; else ln -s -- "$__kimix_target" "$__kimix_link"; fi"#),
    ("move", r#"if [[ $# -lt 2 ]]; then printf '%s\n' 'move: missing source or destination' >&2; return 1; fi; mv -- "$@""#),
    ("nc", r#"local __kimix_z=0 __kimix_v=0 __kimix_w='' __kimix_host='' __kimix_port=''; while (( $# )); do case $1 in -z) __kimix_z=1; shift;; -v) __kimix_v=1; shift;; -zv|-vz) __kimix_z=1; __kimix_v=1; shift;; -w) __kimix_w=$2; shift 2;; -w?*) __kimix_w=${1#-w}; shift;; -*) printf '%s\n' "nc: unsupported option for /dev/tcp fallback: $1" >&2; return 1;; *) if [[ -z $__kimix_host ]]; then __kimix_host=$1; elif [[ -z $__kimix_port ]]; then __kimix_port=$1; else printf '%s\n' 'nc: too many arguments' >&2; return 1; fi; shift;; esac; done; if (( ! __kimix_z )); then printf '%s\n' 'nc: only -z (zero-I/O scan) mode is supported by this fallback' >&2; return 1; fi; if [[ -z $__kimix_host || -z $__kimix_port ]]; then printf '%s\n' 'nc: missing host or port' >&2; return 1; fi; if [[ -n $__kimix_w ]]; then timeout "$__kimix_w" bash -c 'exec 3<>/dev/tcp/$1/$2' _ "$__kimix_host" "$__kimix_port" 2>/dev/null; else (exec 3<>/dev/tcp/"$__kimix_host"/"$__kimix_port") 2>/dev/null; fi; local __kimix_rc=$?; (( __kimix_rc != 0 )) && __kimix_rc=1; if (( __kimix_rc == 0 )); then (( __kimix_v )) && printf '%s\n' "Connection to $__kimix_host $__kimix_port port [tcp/*] succeeded!" >&2; else (( __kimix_v )) && printf '%s\n' "nc: connect to $__kimix_host port $__kimix_port (tcp) failed" >&2; fi; return $__kimix_rc"#),
    ("netcat", r#"local __kimix_z=0 __kimix_v=0 __kimix_w='' __kimix_host='' __kimix_port=''; while (( $# )); do case $1 in -z) __kimix_z=1; shift;; -v) __kimix_v=1; shift;; -zv|-vz) __kimix_z=1; __kimix_v=1; shift;; -w) __kimix_w=$2; shift 2;; -w?*) __kimix_w=${1#-w}; shift;; -*) printf '%s\n' "nc: unsupported option for /dev/tcp fallback: $1" >&2; return 1;; *) if [[ -z $__kimix_host ]]; then __kimix_host=$1; elif [[ -z $__kimix_port ]]; then __kimix_port=$1; else printf '%s\n' 'nc: too many arguments' >&2; return 1; fi; shift;; esac; done; if (( ! __kimix_z )); then printf '%s\n' 'nc: only -z (zero-I/O scan) mode is supported by this fallback' >&2; return 1; fi; if [[ -z $__kimix_host || -z $__kimix_port ]]; then printf '%s\n' 'nc: missing host or port' >&2; return 1; fi; if [[ -n $__kimix_w ]]; then timeout "$__kimix_w" bash -c 'exec 3<>/dev/tcp/$1/$2' _ "$__kimix_host" "$__kimix_port" 2>/dev/null; else (exec 3<>/dev/tcp/"$__kimix_host"/"$__kimix_port") 2>/dev/null; fi; local __kimix_rc=$?; (( __kimix_rc != 0 )) && __kimix_rc=1; if (( __kimix_rc == 0 )); then (( __kimix_v )) && printf '%s\n' "Connection to $__kimix_host $__kimix_port port [tcp/*] succeeded!" >&2; else (( __kimix_v )) && printf '%s\n' "nc: connect to $__kimix_host port $__kimix_port (tcp) failed" >&2; fi; return $__kimix_rc"#),
    ("open", r#"start "$@""#),
    ("pbcopy", r#"clip.exe "$@""#),
    ("pbpaste", r#"powershell.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Console]::Out.Write((Get-Clipboard -Raw))' "$@""#),
    ("pgrep", r#"local __kimix_list=0 __kimix_full=0 __kimix_pat=''; while (( $# )); do case $1 in -l) __kimix_list=1; shift;; -f) __kimix_full=1; shift;; -lf|-fl) __kimix_list=1; __kimix_full=1; shift;; --) shift; break;; -*) printf '%s\n' "pgrep: unsupported option for Get-Process fallback: $1" >&2; return 1;; *) __kimix_pat=$1; shift;; esac; done; if [[ -z $__kimix_pat ]]; then printf '%s\n' 'pgrep: missing pattern' >&2; return 1; fi; if (( __kimix_full )); then __KIMIX_PAT=$__kimix_pat __KIMIX_LIST=$__kimix_list powershell.exe -NoProfile -NonInteractive -Command '$m = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $env:__KIMIX_PAT }; if ($m) { $m | ForEach-Object { if ($env:__KIMIX_LIST -eq "1") { "$($_.ProcessId) $($_.Name)" } else { $_.ProcessId } }; exit 0 } else { exit 1 }'; else __KIMIX_PAT=$__kimix_pat __KIMIX_LIST=$__kimix_list powershell.exe -NoProfile -NonInteractive -Command '$m = Get-Process | Where-Object { $_.Name -match $env:__KIMIX_PAT }; if ($m) { $m | ForEach-Object { if ($env:__KIMIX_LIST -eq "1") { "$($_.Id) $($_.Name)" } else { $_.Id } }; exit 0 } else { exit 1 }'; fi"#),
    ("pidof", r#"if [[ $# -eq 0 ]]; then printf '%s\n' 'pidof: missing process name' >&2; return 1; fi; __KIMIX_NAME=$1 powershell.exe -NoProfile -NonInteractive -Command '$ids = (Get-Process | Where-Object { $_.Name -eq $env:__KIMIX_NAME }).Id; if ($ids) { $ids -join " "; exit 0 } else { exit 1 }'"#),
    ("pip3", r#"pip "$@""#),
    ("pkill", r#"local __kimix_full=0 __kimix_pat=''; while (( $# )); do case $1 in -f) __kimix_full=1; shift;; --) shift; break;; -*) printf '%s\n' "pkill: unsupported option for Stop-Process fallback: $1" >&2; return 1;; *) __kimix_pat=$1; shift;; esac; done; if [[ -z $__kimix_pat ]]; then printf '%s\n' 'pkill: missing pattern' >&2; return 1; fi; if (( __kimix_full )); then __KIMIX_PAT=$__kimix_pat powershell.exe -NoProfile -NonInteractive -Command '$m = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $env:__KIMIX_PAT }; if ($m) { $m | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; exit 0 } else { exit 1 }'; else __KIMIX_PAT=$__kimix_pat powershell.exe -NoProfile -NonInteractive -Command '$m = Get-Process | Where-Object { $_.Name -match $env:__KIMIX_PAT }; if ($m) { $m | Stop-Process -Force; exit 0 } else { exit 1 }'; fi"#),
    ("python3", r#"python "$@""#),
    ("rd", r#"rmdir -- "$@""#),
    ("ren", r#"if [[ $# -ne 2 ]]; then printf '%s\n' 'ren: exactly two arguments required' >&2; return 1; fi; mv -- "$1" "$2""#),
    ("rename", r#"if [[ $# -ne 2 ]]; then printf '%s\n' 'rename: exactly two arguments required' >&2; return 1; fi; mv -- "$1" "$2""#),
    ("rev", r#"local __kimix_zero=0; while (( $# )); do case $1 in -0|--zero) __kimix_zero=1; shift;; --) shift; break;; -*) printf '%s\n' "rev: unsupported option: $1" >&2; return 1;; *) break;; esac; done; perl '-Mopen=:std,:encoding(UTF-8)' -e 'my $zero = shift @ARGV; my $failed = 0; sub reverse_fh { my ($fh, $zero) = @_; local $/ = $zero ? qq(\0) : qq(\n); while (my $record = <$fh>) { my $ended = $zero ? $record =~ s/\0\z// : $record =~ s/\r?\n\z//; print scalar reverse($record); print($zero ? qq(\0) : qq(\n)) if $ended } } if (@ARGV) { for my $file (@ARGV) { if (open my $fh, q(<:encoding(UTF-8)), $file) { reverse_fh($fh, $zero); close $fh } else { warn qq(rev: $file: $!\n); $failed = 1 } } } else { reverse_fh(*STDIN, $zero) } exit $failed' -- "$__kimix_zero" "$@""#),
    ("say", r#"while (( $# )); do case $1 in -*) printf '%s\n' "say: unsupported option for SAPI fallback: $1" >&2; return 1;; *) shift;; esac; done; __KIMIX_SAY_TEXT=$* powershell.exe -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:__KIMIX_SAY_TEXT)'"#),
    ("systeminfo", r"powershell.exe -NoProfile -NonInteractive -Command 'Get-ComputerInfo | Format-List'"),
    ("taskkill", r#"local __kimix_force=0 __kimix_pid='' __kimix_im=''; while (( $# )); do case $1 in /F|/f) __kimix_force=1; shift;; /IM|/im) __kimix_im=$2; shift 2;; /PID|/pid) __kimix_pid=$2; shift 2;; /*) printf '%s\n' "taskkill: unsupported option: $1" >&2; return 1;; *) printf '%s\n' "taskkill: unsupported argument: $1" >&2; return 1;; esac; done; if [[ -n $__kimix_pid ]]; then __KIMIX_FORCE=$__kimix_force __KIMIX_PID=$__kimix_pid powershell.exe -NoProfile -NonInteractive -Command '$force = $env:__KIMIX_FORCE -eq '1'; if ($env:__KIMIX_PID) { Stop-Process -Id $env:__KIMIX_PID -Force:$force; exit 0 } $procs = Get-Process | Where-Object { $_.Name -eq $env:__KIMIX_IM }; if ($procs) { $procs | Stop-Process -Force:$force; exit 0 } else { exit 1 }'; elif [[ -n $__kimix_im ]]; then __KIMIX_FORCE=$__kimix_force __KIMIX_IM=$__kimix_im powershell.exe -NoProfile -NonInteractive -Command '$force = $env:__KIMIX_FORCE -eq '1'; if ($env:__KIMIX_PID) { Stop-Process -Id $env:__KIMIX_PID -Force:$force; exit 0 } $procs = Get-Process | Where-Object { $_.Name -eq $env:__KIMIX_IM }; if ($procs) { $procs | Stop-Process -Force:$force; exit 0 } else { exit 1 }'; else printf '%s\n' 'taskkill: missing /PID or /IM' >&2; return 1; fi"#),
    ("tasklist", r"powershell.exe -NoProfile -NonInteractive -Command 'Get-Process | Select-Object Name, Id, CPU, WorkingSet | Format-Table -AutoSize'"),
    ("traceroute", r#"local -a __kimix_args=(); while (( $# )); do case $1 in -n) __kimix_args+=(-d); shift;; -m) __kimix_args+=(-h "$2"); shift 2;; -m?*) __kimix_args+=(-h "${1#-m}"); shift;; --max-hop=*) __kimix_args+=(-h "${1#*=}"); shift;; -w) __kimix_args+=(-w "$(( $2 * 1000 ))"); shift 2;; -w?*) __kimix_args+=(-w "$(( ${1#-w} * 1000 ))"); shift;; -*) printf '%s\n' "traceroute: unsupported option for tracert fallback: $1" >&2; return 1;; *) __kimix_args+=("$1"); shift;; esac; done; tracert "${__kimix_args[@]}""#),
    ("tree", r#"local __kimix_depth=0 __kimix_all=0 __kimix_dirs=0 __kimix_noreport=0 __kimix_dir=''; while (( $# )); do case $1 in -L) __kimix_depth=$2; shift 2;; -L?*) __kimix_depth=${1#-L}; shift;; -a) __kimix_all=1; shift;; -d) __kimix_dirs=1; shift;; --noreport) __kimix_noreport=1; shift;; --) shift; break;; -*) printf '%s\n' "tree: unsupported option for perl fallback: $1" >&2; return 1;; *) __kimix_dir=$1; shift;; esac; done; [[ -n $__kimix_dir ]] || __kimix_dir=.; perl -e 'my ($maxdepth,$showall,$dirsonly,$noreport,$top)=@ARGV; print qq($top\n); my ($ndirs,$nfiles)=(0,0); sub walk { my ($path,$prefix,$depth)=@_; return if $maxdepth && $depth>$maxdepth; opendir(my $dh,$path) or return; my @e = grep { ! /^[.][.]?$/ } readdir($dh); closedir($dh); @e = grep { $showall || ! /^[.]/ } @e; @e = grep { ! $dirsonly || -d qq($path/$_) } @e; @e = sort { lc($a) cmp lc($b) } @e; my $n=@e; my $i=0; for my $e (@e) { $i++; my $last = $i==$n; my $full = qq($path/$e); my $isdir = -d $full; if ($isdir) { $ndirs++ } else { $nfiles++ } print $prefix, ($last ? qq(`-- ) : qq(|-- )), $e, qq(\n); walk($full, $prefix . ($last ? qq(    ) : qq(|   )), $depth+1) if $isdir && ! -l $full } } walk($top,q(),1); my $dw = $ndirs==1 ? q(directory) : q(directories); my $fw = $nfiles==1 ? q(file) : q(files); print qq(\n$ndirs $dw, $nfiles $fw\n) unless $noreport' -- "$__kimix_depth" "$__kimix_all" "$__kimix_dirs" "$__kimix_noreport" "$__kimix_dir""#),
    ("watch", r#"local __kimix_interval=2; while (( $# )); do case $1 in -n) __kimix_interval=$2; shift 2;; -n?*) __kimix_interval=${1#-n}; shift;; -t|-d|--no-title|--color) shift;; --) shift; break;; -*) printf '%s\n' "watch: unsupported option: $1" >&2; return 1;; *) break;; esac; done; if [[ $# -eq 0 ]]; then printf '%s\n' 'watch: missing command' >&2; return 1; fi; while true; do clear; eval "$*"; sleep "$__kimix_interval"; done"#),
    ("wget", r#"local __kimix_url='' __kimix_out='' __kimix_stdout=0; local -a __kimix_args=(); while (( $# )); do case $1 in -O|--output-document) __kimix_out=$2; shift 2;; -O?*) __kimix_out=${1#-O}; shift;; --output-document=*) __kimix_out=${1#*=}; shift;; -q|--quiet) __kimix_args+=(-s); shift;; -c|--continue) __kimix_args+=(-C -); shift;; --no-check-certificate) __kimix_args+=(-k); shift;; -T|--timeout) __kimix_args+=(--max-time "$2"); shift 2;; --timeout=*) __kimix_args+=(--max-time "${1#*=}"); shift;; -*) printf '%s\n' "wget: unsupported option for curl fallback: $1" >&2; return 1;; *) __kimix_url=$1; shift;; esac; done; if [[ -z $__kimix_url ]]; then printf '%s\n' 'wget: missing URL' >&2; return 1; fi; if [[ $__kimix_out == '-' ]]; then __kimix_stdout=1; fi; if [[ -z $__kimix_out && $__kimix_stdout -eq 0 ]]; then __kimix_out=${__kimix_url##*/}; [[ -n $__kimix_out ]] || __kimix_out=index.html; fi; if (( __kimix_stdout )); then curl -fSL "${__kimix_args[@]}" -- "$__kimix_url"; else curl -fSL "${__kimix_args[@]}" -o "$__kimix_out" -- "$__kimix_url"; fi"#),
    ("where", r#"which "$@""#),
    ("wl-copy", r#"while (( $# )); do case $1 in -*) printf '%s\n' "wl-copy: unsupported option for clipboard fallback: $1" >&2; return 1;; *) shift;; esac; done; clip.exe"#),
    ("wl-paste", r#"while (( $# )); do case $1 in -n|--no-newline) shift;; -*) printf '%s\n' "wl-paste: unsupported option for clipboard fallback: $1" >&2; return 1;; *) shift;; esac; done; powershell.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Console]::Out.Write((Get-Clipboard -Raw))'"#),
    ("xclip", r#"local __kimix_out=0; while (( $# )); do case $1 in -o|-out) __kimix_out=1; shift;; -i|-in) shift;; -selection|-d|-display) shift 2;; -selection*|-display*) shift;; -*) printf '%s\n' "xclip: unsupported option for clipboard fallback: $1" >&2; return 1;; *) shift;; esac; done; if (( __kimix_out )); then powershell.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Console]::Out.Write((Get-Clipboard -Raw))'; else clip.exe; fi"#),
    ("xcopy", r#"cp -r -- "$@""#),
    ("xdg-open", r#"start "$@""#),
    ("xsel", r#"local __kimix_out=0; while (( $# )); do case $1 in --output) __kimix_out=1; shift;; --input|--clipboard|--primary|--secondary) shift;; --*) printf '%s\n' "xsel: unsupported option for clipboard fallback: $1" >&2; return 1;; -*) case $1 in *o*) __kimix_out=1;; esac; shift;; *) shift;; esac; done; if (( __kimix_out )); then powershell.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Console]::Out.Write((Get-Clipboard -Raw))'; else clip.exe; fi"#),
    ("zip", r#"local __kimix_archive='' __kimix_level=Optimal __kimix_p='' __kimix_combo='' __kimix_i=0; local -a __kimix_paths=() __kimix_wpaths=() __kimix_split=(); while (( $# )); do if [[ $1 == -[!-]* && ${#1} -gt 2 ]]; then __kimix_combo=${1#-}; __kimix_split=(); shift; for (( __kimix_i=0; __kimix_i<${#__kimix_combo}; __kimix_i++ )); do __kimix_split+=(-${__kimix_combo:__kimix_i:1}); done; set -- "${__kimix_split[@]}" "$@"; continue; fi; case $1 in -r|-R|--recurse-paths|-q|--quiet) shift;; -0) __kimix_level=NoCompression; shift;; -1) __kimix_level=Fastest; shift;; -[2-9]) shift;; -*) printf '%s\n' "zip: unsupported option for Compress-Archive fallback: $1" >&2; return 1;; *) if [[ -z $__kimix_archive ]]; then __kimix_archive=$1; else __kimix_paths+=("$1"); fi; shift;; esac; done; if [[ -z $__kimix_archive || ${#__kimix_paths[@]} -eq 0 ]]; then printf '%s\n' 'zip: missing archive name or input paths' >&2; return 1; fi; for __kimix_p in "${__kimix_paths[@]}"; do __kimix_wpaths+=("$(cygpath -w -- "$__kimix_p")"); done; __kimix_archive=$(cygpath -w -- "$__kimix_archive"); __KIMIX_ZIP_LEVEL=$__kimix_level __KIMIX_ZIP_DEST=$__kimix_archive __KIMIX_ZIP_PATHS=$(printf '%s\n' "${__kimix_wpaths[@]}") powershell.exe -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem; $level = [System.IO.Compression.CompressionLevel]$env:__KIMIX_ZIP_LEVEL; $dest = $env:__KIMIX_ZIP_DEST; if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }; $zip = [System.IO.Compression.ZipFile]::Open($dest, [System.IO.Compression.ZipArchiveMode]::Create); foreach ($p in ($env:__KIMIX_ZIP_PATHS -split "`n")) { $item = Get-Item -LiteralPath $p; $base = $item.Name; if ($item.PSIsContainer) { $root = $item.FullName; Get-ChildItem -LiteralPath $root -Recurse -Force | ForEach-Object { $rel = $_.FullName.Substring($root.Length).TrimStart("\") -replace "\\", "/"; if ($_.PSIsContainer) { $zip.CreateEntry($base + "/" + $rel + "/") | Out-Null } else { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $base + "/" + $rel, $level) | Out-Null } } } else { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $item.FullName, $base, $level) | Out-Null } }; $zip.Dispose(); if (Test-Path -LiteralPath $dest) { exit 0 } else { exit 1 }'"#),
];

pub const STUB_AWARE_FALLBACKS: &[&str] = &["pip3", "python3"];
pub const COMMAND_START_KEYWORDS: &[&str] = &["!", "{", "if", "then", "elif", "else", "while", "until", "do"];
pub const COMMAND_END_KEYWORDS: &[&str] = &["fi", "done", "esac"];
pub const LIST_KEYWORDS: &[&str] = &["for", "select", "case"];
pub const COMMAND_WRAPPERS: &[&str] = &[
    "command", "coproc", "env", "exec", "nohup", "sudo", "time", "timeout", "stdbuf", "nice", "xargs",
];
pub const FALLBACK_COMMAND_WRAPPERS: &[(&str, &str)] = &[("gtimeout", "timeout"), ("watch", "watch")];
pub const WRAPPER_OPERAND_COUNTS: &[(&str, usize)] = &[("timeout", 1)];
pub const SAME_SHELL_WRAPPERS: &[&str] = &["coproc", "time", "watch"];
pub const SHELL_WRAPPERS: &[&str] = &["bash", "sh", "dash", "ash"];
pub const SHELL_C_OPTIONS_RE: &str = "^-c$|^-lc$|^-cl$";
pub const WRAPPER_OPTIONS_WITH_VALUE: &[(&str, &[&str])] = &[
    ("env", &["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
    ("exec", &["-a"]),
    ("sudo", &["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host", "-p", "--prompt", "-R", "--chroot", "-r", "--role", "-t", "--type", "-T", "--command-timeout", "-u", "--user"]),
    ("time", &["-f", "--format", "-o", "--output"]),
    ("timeout", &["-k", "--kill-after", "-s", "--signal"]),
    ("stdbuf", &["-o", "-e", "-i", "--output", "--error", "--input"]),
    ("nice", &["-n", "--adjustment"]),
    ("xargs", &["-I", "-n", "-L", "-P", "-s", "-S", "-a", "-d", "-E", "--arg-file", "--max-args", "--max-chars", "--max-procs", "--max-lines", "--replace", "--eof", "--delimiter"]),
    ("watch", &["-n", "--interval"]),
];
pub const WRAPPER_PATH_OPTIONS: &[(&str, &[&str])] = &[
    ("env", &["-C", "--chdir"]),
    ("sudo", &["-D", "--chdir"]),
    ("time", &["-o", "--output"]),
    ("xargs", &["-a", "--arg-file"]),
];
pub const WRAPPER_PATH_OPTION_LONG: &[&str] = &["--chdir", "--output", "--arg-file"];
pub const HEREDOC_TRAILING_OPERATORS: &[&str] = &["&&", "||", "|", "|&", ";", "&"];

const OPERATOR_CHARS: &str = ";&|()<>\n";
const REDIRECTION_START: &str = "<>";
const WORD_END_CHARS: &str = ";&|()<>\n \t\r";
const MAX_NESTING_DEPTH: usize = 1024;
const ESCAPED_LITERAL_CHARS: &str = " \t&;|()<>#'\"$`{}!";
const PATH_SAFE_CHARS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./:~@%+=-#,[]*?";

// =====================================================================
// Regex helpers (mirror the compiled patterns from _shell_compat.py).
// =====================================================================

/// `[A-Za-z_][A-Za-z0-9_]*(?:\+)?=`
fn is_assignment(raw: &str) -> bool {
    let b = raw.as_bytes();
    if b.is_empty() || !is_ascii_name_start(b[0]) {
        return false;
    }
    let mut i = 1;
    while i < b.len() && is_ascii_name_char(b[i]) {
        i += 1;
    }
    if i < b.len() && b[i] == b'+' {
        i += 1;
    }
    i < b.len() && b[i] == b'='
}

/// `[A-Za-z_][A-Za-z0-9_]*`
fn is_name(raw: &str) -> bool {
    let b = raw.as_bytes();
    !b.is_empty() && is_ascii_name_start(b[0]) && b[1..].iter().all(|&c| is_ascii_name_char(c))
}

/// `[A-Za-z]:\\.*`
fn is_drive_abs(raw: &str) -> bool {
    let b = raw.as_bytes();
    b.len() >= 3 && is_ascii_letter(b[0]) && b[1] == b':' && b[2] == b'\\'
}

/// `[A-Za-z0-9_.~\\-]+` (decoded value of a plausible multi-segment path).
fn is_path_segment_word(raw: &str) -> bool {
    !raw.is_empty()
        && raw.bytes().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'~' | b'\\' | b'-')
        })
}

fn is_ascii_letter(c: u8) -> bool {
    c.is_ascii_alphabetic()
}

fn is_ascii_name_start(c: u8) -> bool {
    c == b'_' || c.is_ascii_alphabetic()
}

fn is_ascii_name_char(c: u8) -> bool {
    c == b'_' || c.is_ascii_alphanumeric()
}

/// `^-c$|^-lc$|^-cl$`
fn is_shell_c_option(raw: &str) -> bool {
    matches!(raw, "-c" | "-lc" | "-cl")
}

fn contains(list: &[&str], item: &str) -> bool {
    list.contains(&item)
}

fn option_value_for<'a>(table: &'a [(&str, &[&str])], kind: &str) -> Option<&'a [&'a str]> {
    table.iter().find(|(k, _)| *k == kind).map(|(_, v)| *v)
}

fn contains_option(table: &[(&str, &[&str])], kind: &str, raw: &str) -> bool {
    option_value_for(table, kind)
        .map(|opts| opts.contains(&raw))
        .unwrap_or(false)
}

// =====================================================================
// Fallback definitions
// =====================================================================

fn native_delegate(name: &str) -> String {
    format!(
        "local __kimix_native=''; __kimix_native=$(type -P {name}) || :; \
         if [[ -n $__kimix_native ]]; then \"$__kimix_native\" \"$@\"; return; fi; "
    )
}

fn fallback_definition_from_body(name: &str, body: &str) -> String {
    if contains(STUB_AWARE_FALLBACKS, name) {
        // The Microsoft Store App Execution Alias satisfies ``command -v`` but
        // is not a working interpreter: define the fallback anyway, and never
        // delegate to the stub path.
        let guard = format!(
            "if ! command -v {name} >/dev/null 2>&1 \
             || [[ $(type -P {name}) == *WindowsApps* ]]; then "
        );
        let delegate = format!(
            "local __kimix_native=''; __kimix_native=$(type -P {name}) || :; \
             if [[ -n $__kimix_native && $__kimix_native != *WindowsApps* ]]; then \
             \"$__kimix_native\" \"$@\"; return; fi; "
        );
        format!("{guard}{name}() {{ {delegate}{body}; }}; fi")
    } else {
        let guard = format!("if ! command -v {name} >/dev/null 2>&1; then ");
        format!("{guard}{name}() {{ {}{body}; }}; fi", native_delegate(name))
    }
}

static FALLBACKS: LazyLock<HashMap<&'static str, String>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    for &(name, body) in FALLBACK_BODIES {
        m.insert(name, fallback_definition_from_body(name, body));
    }
    m
});

fn fallback_definition(name: &str) -> &'static str {
    FALLBACKS
        .get(name)
        .map(String::as_str)
        .expect("fallback name must be present in FALLBACK_BODIES")
}

fn single_quote(command: &str) -> String {
    let mut out = String::with_capacity(command.len() + 2);
    out.push('\'');
    for ch in command.chars() {
        if ch == '\'' {
            out.push_str("'\"'\"'");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

fn wrapper_runner(name: &str) -> String {
    let script = format!("{}; {name} \"$@\"", fallback_definition(name));
    format!("/usr/bin/bash -c {} --", single_quote(&script))
}

fn windows_temp_dir() -> String {
    std::env::temp_dir().to_string_lossy().replace('\\', "/")
}

// =====================================================================
// Result types
// =====================================================================

/// Result of [`fix_bash_command`].
///
/// `replacements` records each original command name in source order and
/// `path_changes` each original argument or command word whose Windows-style
/// backslashes, Git Bash virtual absolute path (`/tmp/x`, `/c/x`), or cmd.exe
/// `/d` flag were rewritten for Git Bash.  `shell_wrappers` records each
/// redundant `bash`/`sh` invocation that was unwrapped.  Empty tuples mean the
/// command was returned byte-for-byte unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BashFix {
    pub command: String,
    pub replacements: Vec<String>,
    pub path_changes: Vec<String>,
    pub shell_wrappers: Vec<String>,
}

impl BashFix {
    pub fn unchanged(command: String) -> Self {
        BashFix {
            command,
            replacements: Vec::new(),
            path_changes: Vec::new(),
            shell_wrappers: Vec::new(),
        }
    }

    /// Whether any compatibility replacement was made.
    pub fn changed(&self) -> bool {
        !self.replacements.is_empty()
            || !self.path_changes.is_empty()
            || !self.shell_wrappers.is_empty()
    }

    /// A concise description of compatibility changes.
    pub fn warning(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if !self.replacements.is_empty() {
            let names: Vec<String> = self
                .replacements
                .iter()
                .map(|n| format!("`{n}`"))
                .collect();
            parts.push(format!(
                "Added Windows Git Bash fallback(s) for native command(s): {}.",
                names.join(", ")
            ));
        }
        if !self.path_changes.is_empty() {
            let words: Vec<String> = self.path_changes.iter().map(|w| format!("`{w}`")).collect();
            parts.push(format!(
                "Rewrote Windows path(s) for Git Bash (backslashes to forward slashes; Git Bash virtual paths to native spellings): {}.",
                words.join(", ")
            ));
        }
        if !self.shell_wrappers.is_empty() {
            let names: Vec<String> = self
                .shell_wrappers
                .iter()
                .map(|n| format!("`{n}`"))
                .collect();
            parts.push(format!(
                "Removed redundant shell wrapper(s): {}.",
                names.join(", ")
            ));
        }
        parts.join(" ")
    }
}

#[derive(Debug, Clone)]
struct BashWrapper {
    kind: String,
    skip_next: bool,
    opaque: bool,
    path_value: bool,
    operands: usize,
}

impl BashWrapper {
    fn new(kind: &str, operands: usize) -> Self {
        BashWrapper {
            kind: kind.to_string(),
            skip_next: false,
            opaque: false,
            path_value: false,
            operands,
        }
    }
}

#[derive(Debug, Clone)]
struct BashHereDoc {
    delimiter: Option<String>,
    strip_tabs: bool,
    expands: bool,
}

// =====================================================================
// Scanner
// =====================================================================

/// Conservative scanner for Bash executable command positions.
struct BashFixScanner {
    s: String,
    n: usize,
    edits: Vec<(usize, usize, String)>,
    names: Vec<String>,
    path_notes: Vec<String>,
    shell_notes: Vec<String>,
    heredoc_events: Vec<(usize, usize)>,
    nest_depth: usize,
}

impl BashFixScanner {
    fn new(command: &str) -> Self {
        let n = command.len();
        BashFixScanner {
            s: command.to_string(),
            n,
            edits: Vec::new(),
            names: Vec::new(),
            path_notes: Vec::new(),
            shell_notes: Vec::new(),
            heredoc_events: Vec::new(),
            nest_depth: 0,
        }
    }

    fn fix(mut self) -> BashFix {
        self.scan_range(0, self.n);
        if self.names.is_empty() && self.edits.is_empty() && self.shell_notes.is_empty() {
            return BashFix::unchanged(self.s);
        }
        let mut unique_names: Vec<String> = Vec::new();
        for name in &self.names {
            if !unique_names.contains(name) {
                unique_names.push(name.clone());
            }
        }
        let definitions: Vec<String> = unique_names
            .iter()
            .map(|name| fallback_definition(name).to_string())
            .collect();
        let exports: Vec<String> = unique_names
            .iter()
            .map(|name| format!("export -f {name}"))
            .collect();
        let mut source = self.build_source();
        source = fix_heredoc_trailing_operators(&source);
        let mut prefix = String::new();
        if !definitions.is_empty() {
            prefix.push_str(&definitions.join("\n"));
            prefix.push('\n');
            prefix.push_str(&exports.join("\n"));
            prefix.push('\n');
        }
        BashFix {
            command: prefix + &source,
            replacements: self.names,
            path_changes: self.path_notes,
            shell_wrappers: self.shell_notes,
        }
    }

    /// Return the source with all recorded edits applied.
    fn build_source(&self) -> String {
        if self.edits.is_empty() {
            return self.s.clone();
        }
        let mut sorted: Vec<&(usize, usize, String)> = self.edits.iter().collect();
        sorted.sort_by_key(|(start, _, _)| *start);
        let mut out = String::new();
        let mut previous = 0;
        for (start, end, replacement) in sorted {
            out.push_str(&self.s[previous..*start]);
            out.push_str(replacement);
            previous = *end;
        }
        out.push_str(&self.s[previous..]);
        out
    }

    /// Return the word value produced solely by Bash quote removal.
    ///
    /// Only words whose value can be determined without any expansion are
    /// accepted; parameter/command/arithmetic expansions, globbing, and
    /// malformed quotes return `None` so the caller leaves them untouched.
    fn literal_word_value(raw: &str) -> Option<String> {
        let bytes = raw.as_bytes();
        let mut value: Vec<u8> = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            let ch = bytes[i];
            if ch == b'\\' {
                if i + 1 >= bytes.len() {
                    return None;
                }
                if bytes[i + 1] == b'\n' {
                    i += 2;
                    continue;
                }
                value.push(bytes[i + 1]);
                i += 2;
                continue;
            }
            if ch == b'\'' {
                let close = find_byte(raw, b'\'', i + 1);
                let close = close?;
                value.extend_from_slice(&bytes[i + 1..close]);
                i = close + 1;
                continue;
            }
            if ch == b'"' {
                i += 1;
                loop {
                    if i >= bytes.len() || bytes[i] == b'"' {
                        break;
                    }
                    let inner = bytes[i];
                    if inner == b'$' || inner == b'`' {
                        return None;
                    }
                    if inner == b'\\' && i + 1 < bytes.len() {
                        let escaped = bytes[i + 1];
                        if matches!(escaped, b'$' | b'`' | b'"' | b'\\' | b'\n') {
                            if escaped != b'\n' {
                                value.push(escaped);
                            }
                            i += 2;
                            continue;
                        }
                    }
                    value.push(inner);
                    i += 1;
                }
                if i >= bytes.len() {
                    return None;
                }
                i += 1;
                continue;
            }
            if matches!(ch, b'$' | b'`' | b'*' | b'?' | b'[' | b'{' | b'~') {
                return None;
            }
            value.push(ch);
            i += 1;
        }
        String::from_utf8(value).ok()
    }

    /// Return the fallback command name produced by Bash quote removal.
    fn literal_command_name(raw: &str) -> Option<String> {
        let name = Self::literal_word_value(raw)?;
        if FALLBACK_BODIES.iter().any(|(n, _)| *n == name) {
            Some(name)
        } else {
            None
        }
    }

    /// Return the shell name when *raw* is a literal `bash`/`sh` word.
    fn shell_wrapper_name(raw: &str) -> Option<String> {
        let name = Self::literal_word_value(raw)?;
        if contains(SHELL_WRAPPERS, &name) {
            Some(name)
        } else {
            None
        }
    }

    /// Return True when *raw* looks like a script path, not a command word.
    fn plausible_script_file(raw: &str) -> bool {
        if raw.starts_with("./")
            || raw.starts_with("../")
            || raw.starts_with(".\\")
            || raw.starts_with("..\\")
        {
            return true;
        }
        if raw.contains('/') || raw.contains('\\') {
            return true;
        }
        let lower = raw.to_ascii_lowercase();
        [
            ".sh", ".bash", ".zsh", ".ksh", ".dash", ".ash", ".bats",
        ]
        .iter()
        .any(|ext| lower.ends_with(ext))
    }

    /// Repairs a redundant `bash`/`sh` invocation at a command position.
    ///
    /// Returns `Some((scan index, keep_wrapper))` when the wrapper was
    /// rewritten, or `None` when the wrapper is left untouched.  See the
    /// module docstring for the full semantics.
    fn handle_shell_wrapper(
        &mut self,
        shell_name: &str,
        word_start: usize,
        mut i: usize,
        end: usize,
        assignment_prefix: bool,
        wrapped: bool,
    ) -> Option<(usize, bool)> {
        if assignment_prefix {
            // `VAR=x bash -c 'echo $VAR'`: the assignment is scoped to the
            // shell *process*, so unwrapping would make the outer shell expand
            // `$VAR` before the assignment takes effect.  Keep the wrapper.
            return None;
        }
        let sb = self.s.as_bytes();
        while i < end && matches!(sb[i], b' ' | b'\t' | b'\r') {
            i += 1;
        }
        if i >= end || OPERATOR_CHARS.as_bytes().contains(&sb[i]) || sb[i] == b'#' {
            return None;
        }
        let next_end = self.read_word(i, end, true);
        if next_end <= i {
            return None;
        }
        let next_raw = self.s[i..next_end].to_string();

        if next_raw.starts_with('-') {
            // Optional leading login flag, then the `-c` family.
            let mut opt_end = next_end;
            let mut opt = next_raw;
            if opt == "-l" || opt == "-L" || opt == "--login" {
                let mut cursor = opt_end;
                while cursor < end && matches!(self.s.as_bytes()[cursor], b' ' | b'\t' | b'\r') {
                    cursor += 1;
                }
                if cursor >= end
                    || OPERATOR_CHARS.as_bytes().contains(&self.s.as_bytes()[cursor])
                    || self.s.as_bytes()[cursor] == b'#'
                {
                    return None;
                }
                opt_end = self.read_word(cursor, end, true);
                if opt_end <= cursor {
                    return None;
                }
                opt = self.s[cursor..opt_end].to_string();
            }
            if !is_shell_c_option(&opt) {
                return None;
            }
            // The word after `-c` is the inline script.
            let mut k = opt_end;
            while k < end && matches!(self.s.as_bytes()[k], b' ' | b'\t' | b'\r') {
                k += 1;
            }
            if k >= end || OPERATOR_CHARS.as_bytes().contains(&self.s.as_bytes()[k]) || self.s.as_bytes()[k] == b'#' {
                return None;
            }
            let script_end = self.read_word(k, end, true);
            if script_end <= k {
                return None;
            }
            let mut m = script_end;
            while m < end && matches!(self.s.as_bytes()[m], b' ' | b'\t' | b'\r') {
                m += 1;
            }
            if m < end
                && !OPERATOR_CHARS.as_bytes().contains(&self.s.as_bytes()[m])
                && self.s.as_bytes()[m] != b'#'
            {
                return None; // trailing script argv: `$0`/`$1` semantics
            }
            let script_raw = self.s[k..script_end].to_string();
            let Some(script) = Self::literal_word_value(&script_raw) else {
                return None;
            };
            let mut inner = BashFixScanner::new(&script);
            inner.scan_range(0, script.len());
            let fixed = fix_heredoc_trailing_operators(&inner.build_source());
            for name in &inner.names {
                if !self.names.contains(name) {
                    self.names.push(name.clone());
                }
            }
            self.path_notes.extend(inner.path_notes.iter().cloned());
            for name in &inner.shell_notes {
                if !self.shell_notes.contains(name) {
                    self.shell_notes.push(name.clone());
                }
            }
            if wrapped {
                // Keep `<wrapper> bash -c '<script>'` and fix the script in
                // place: the wrapper runs bash natively and the nested bash
                // inherits the exported fallback functions.
                if !inner.edits.is_empty() {
                    self.edits.push((k, script_end, single_quote(&fixed)));
                }
                return Some((script_end, true));
            }
            self.edits.push((word_start, script_end, fixed));
            self.shell_notes.push(format!("{shell_name} -c"));
            return Some((script_end, false));
        }

        if Self::plausible_script_file(&next_raw) {
            return None;
        }
        // `bash <command> ...`: drop the redundant shell word itself.
        self.edits.push((word_start, i, String::new()));
        self.shell_notes.push(shell_name.to_string());
        Some((i, wrapped))
    }

    /// Fix the inline script of a quoted `watch` command operand.
    fn watch_command_operand(&mut self, word_start: usize, word_end: usize, raw: &str) {
        if !(raw.starts_with('\'') || raw.starts_with('"')) {
            return;
        }
        let Some(script) = Self::literal_word_value(raw) else {
            return;
        };
        let mut inner = BashFixScanner::new(&script);
        inner.scan_range(0, script.len());
        let fixed = fix_heredoc_trailing_operators(&inner.build_source());
        for name in &inner.names {
            if !self.names.contains(name) {
                self.names.push(name.clone());
            }
        }
        self.path_notes.extend(inner.path_notes.iter().cloned());
        for name in &inner.shell_notes {
            if !self.shell_notes.contains(name) {
                self.shell_notes.push(name.clone());
            }
        }
        if !inner.edits.is_empty() {
            self.edits.push((word_start, word_end, single_quote(&fixed)));
        }
    }
}

impl BashFixScanner {
    /// Scan *start..end* as a command context, bounding recursion depth.
    fn scan_range(&mut self, start: usize, end: usize) {
        if self.nest_depth >= MAX_NESTING_DEPTH {
            return;
        }
        self.nest_depth += 1;
        self.scan_range_inner(start, end);
        self.nest_depth -= 1;
    }

    fn scan_range_inner(&mut self, start: usize, end: usize) {
        let mut i = start;
        let mut command_expected = true;
        let mut redirect_expected = false;
        let mut redirect_resume = true;
        let mut wrapper: Option<BashWrapper> = None;
        let mut heredoc_operator: Option<&'static str> = None;
        let mut herestring_flag = false;
        let mut pending_heredocs: Vec<BashHereDoc> = Vec::new();
        let mut case_stack: Vec<&'static str> = Vec::new();
        let mut function_name_expected = false;
        let mut function_body_expected = false;
        let mut assignment_prefix = false;

        while i < end {
            let ch = self.s.as_bytes()[i];

            if matches!(ch, b' ' | b'\t' | b'\r') {
                i += 1;
                continue;
            }
            if ch == b'\\' && i + 1 < end && self.s.as_bytes()[i + 1] == b'\n' {
                i += 2;
                continue;
            }
            if ch == b'\n' {
                i += 1;
                if !pending_heredocs.is_empty() {
                    let mut docs = std::mem::take(&mut pending_heredocs);
                    i = self.skip_heredoc_bodies(i, end, &mut docs, true);
                }
                command_expected = true;
                redirect_expected = false;
                heredoc_operator = None;
                herestring_flag = false;
                wrapper = None;
                assignment_prefix = false;
                continue;
            }
            if ch == b'#' && self.comment_starts(i, start) {
                let newline = find_newline(&self.s, i + 1, end);
                i = if newline < 0 { end } else { newline as usize };
                continue;
            }

            let process_substitution = REDIRECTION_START.as_bytes().contains(&ch)
                && (self.starts_with("<(", i) || self.starts_with(">(", i));
            if !process_substitution
                && (REDIRECTION_START.as_bytes().contains(&ch)
                    || (ch == b'&' && self.starts_with("&>", i))
                    || (ch.is_ascii_digit() && self.redirection_after_fd(i, end)))
            {
                let op_start = i;
                if ch.is_ascii_digit() {
                    while i < end && self.s.as_bytes()[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                let (op, next_i) = self.read_redirection(i, end);
                if !op.is_empty() {
                    redirect_resume = command_expected;
                    redirect_expected = true;
                    herestring_flag = op == "<<<";
                    if op == "<<" || op == "<<-" {
                        heredoc_operator = Some(if op == "<<-" { "<<-" } else { "<<" });
                    }
                    i = next_i;
                    continue;
                }
                i = op_start;
            }

            if redirect_expected {
                if self.starts_with("<(", i) || self.starts_with(">(", i) {
                    let close = self.find_matching(i + 2, end, ")");
                    let inner_end = if close < end { close } else { end };
                    self.scan_range(i + 2, inner_end);
                    let word_end = if close < end { close + 1 } else { end };
                    if word_end <= i {
                        i += 1;
                        continue;
                    }
                    if heredoc_operator == Some("<<") || heredoc_operator == Some("<<-") {
                        let heredoc = self.heredoc_delimiter(&self.s[i..word_end]);
                        if let Some((delimiter, expands)) = heredoc {
                            pending_heredocs.push(BashHereDoc {
                                delimiter,
                                strip_tabs: heredoc_operator == Some("<<-"),
                                expands,
                            });
                        }
                    } else if !herestring_flag {
                        let raw_word = &self.s[i..word_end];
                        if let Some(replacement) = self.path_replacement(raw_word) {
                            self.edits.push((i, word_end, replacement));
                            self.path_notes.push(raw_word.to_string());
                        }
                    }
                    i = word_end;
                    command_expected = redirect_resume;
                    redirect_expected = false;
                    heredoc_operator = None;
                    continue;
                }
                let scan_substitutions =
                    !(heredoc_operator == Some("<<") || heredoc_operator == Some("<<-"));
                let word_end = self.read_word(i, end, scan_substitutions);
                if word_end <= i {
                    i += 1;
                    continue;
                }
                if heredoc_operator == Some("<<") || heredoc_operator == Some("<<-") {
                    let heredoc = self.heredoc_delimiter(&self.s[i..word_end]);
                    if let Some((delimiter, expands)) = heredoc {
                        pending_heredocs.push(BashHereDoc {
                            delimiter,
                            strip_tabs: heredoc_operator == Some("<<-"),
                            expands,
                        });
                    }
                } else if !herestring_flag {
                    let raw_word = &self.s[i..word_end];
                    if let Some(replacement) = self.path_replacement(raw_word) {
                        self.edits.push((i, word_end, replacement));
                        self.path_notes.push(raw_word.to_string());
                    }
                }
                i = word_end;
                command_expected = redirect_resume;
                redirect_expected = false;
                heredoc_operator = None;
                continue;
            }

            if self.starts_with("[[", i) && ch == b'[' {
                function_body_expected = false;
                i = self.skip_conditional(i + 2, end);
                command_expected = false;
                continue;
            }
            if self.starts_with("((", i) && ch == b'(' {
                function_body_expected = false;
                i = self.skip_arithmetic(i + 2, end);
                command_expected = false;
                continue;
            }
            if ch == b'$' && self.starts_with("$(", i) && !self.starts_with("$((", i) {
                let close = self.find_matching(i + 2, end, ")");
                let inner_end = if close < end { close } else { end };
                self.scan_range(i + 2, inner_end);
                i = if close < end { close + 1 } else { end };
                if case_stack.last() == Some(&"word") {
                    if let Some(top) = case_stack.last_mut() {
                        *top = "await-in";
                    }
                }
                command_expected = false;
                continue;
            }
            if ch == b'`' {
                let close = self.find_backtick_end(i + 1, end);
                self.scan_range(i + 1, close);
                i = if close < end { close + 1 } else { end };
                if case_stack.last() == Some(&"word") {
                    if let Some(top) = case_stack.last_mut() {
                        *top = "await-in";
                    }
                }
                command_expected = false;
                continue;
            }
            if REDIRECTION_START.as_bytes().contains(&ch)
                && (self.starts_with("<(", i) || self.starts_with(">(", i))
            {
                let close = self.find_matching(i + 2, end, ")");
                let inner_end = if close < end { close } else { end };
                self.scan_range(i + 2, inner_end);
                i = if close < end { close + 1 } else { end };
                if case_stack.last() == Some(&"word") {
                    if let Some(top) = case_stack.last_mut() {
                        *top = "await-in";
                    }
                }
                command_expected = false;
                continue;
            }

            let (op, op_end) = self.read_control_operator(i, end);
            if !op.is_empty() {
                i = op_end;
                if op == "(" && function_body_expected {
                    function_body_expected = false;
                    command_expected = true;
                } else if op == "(" {
                    command_expected = true;
                } else if op == ")" {
                    if case_stack.last() == Some(&"patterns") {
                        if let Some(top) = case_stack.last_mut() {
                            *top = "body";
                        }
                        command_expected = true;
                    } else {
                        command_expected = false;
                    }
                } else if op == ";;" || op == ";&" || op == ";;&" {
                    if !case_stack.is_empty() {
                        if let Some(top) = case_stack.last_mut() {
                            *top = "patterns";
                        }
                        command_expected = false;
                    } else {
                        command_expected = true;
                    }
                } else {
                    command_expected = true;
                }
                redirect_expected = false;
                heredoc_operator = None;
                wrapper = None;
                assignment_prefix = false;
                continue;
            }

            let word_start = i;
            let scan_substitutions =
                !(heredoc_operator == Some("<<") || heredoc_operator == Some("<<-"));
            let word_end = self.read_word(i, end, scan_substitutions);
            if word_end <= i {
                i += 1;
                continue;
            }
            let raw = self.s[word_start..word_end].to_string();
            i = word_end;

            if function_name_expected {
                function_name_expected = false;
                function_body_expected = true;
                command_expected = false;
                if let Some(declaration_end) = self.empty_parentheses_end(i, end) {
                    i = declaration_end;
                }
                continue;
            }

            if function_body_expected {
                function_body_expected = false;
                if raw == "{" {
                    command_expected = true;
                    continue;
                }
            }

            if case_stack.last() == Some(&"word") {
                if let Some(top) = case_stack.last_mut() {
                    *top = "await-in";
                }
                command_expected = false;
                continue;
            }
            if case_stack.last() == Some(&"await-in") && raw == "in" {
                if let Some(top) = case_stack.last_mut() {
                    *top = "patterns";
                }
                command_expected = false;
                continue;
            }
            if case_stack.last() == Some(&"patterns") {
                if raw == "esac" {
                    case_stack.pop();
                }
                command_expected = false;
                continue;
            }

            if !command_expected {
                if raw == "then" || raw == "do" || raw == "else" || raw == "elif" {
                    command_expected = true;
                } else if raw == "esac" && !case_stack.is_empty() {
                    case_stack.pop();
                } else {
                    if let Some(replacement) = self.path_replacement(&raw) {
                        self.edits.push((word_start, word_end, replacement));
                        self.path_notes.push(raw.clone());
                    }
                    if is_assignment(&raw) && i < end && self.s.as_bytes()[i] == b'(' {
                        let close = self.find_matching(i + 1, end, ")");
                        let inner_end = if close < end { close } else { end };
                        self.scan_array_words(i + 1, inner_end);
                        i = if close < end { close + 1 } else { end };
                    }
                }
                continue;
            }

            if raw == "function" {
                function_name_expected = true;
                command_expected = true;
                continue;
            }
            if let Some(declaration_end) = self.function_declaration_end(&raw, i, end) {
                i = declaration_end;
                function_body_expected = true;
                command_expected = false;
                continue;
            }
            if contains(COMMAND_START_KEYWORDS, &raw) {
                command_expected = true;
                continue;
            }
            if contains(COMMAND_END_KEYWORDS, &raw) {
                if raw == "esac" && !case_stack.is_empty() {
                    case_stack.pop();
                }
                command_expected = false;
                continue;
            }
            if contains(LIST_KEYWORDS, &raw) {
                if raw == "case" {
                    case_stack.push("word");
                }
                command_expected = false;
                continue;
            }
            if is_assignment(&raw) {
                if i < end && self.s.as_bytes()[i] == b'(' {
                    let close = self.find_matching(i + 1, end, ")");
                    let inner_end = if close < end { close } else { end };
                    self.scan_array_words(i + 1, inner_end);
                    i = if close < end { close + 1 } else { end };
                }
                command_expected = true;
                assignment_prefix = true;
                continue;
            }

            if raw == "cd" {
                self.drop_cmd_cd_flag(i, end);
            }

            let executable_wrapper = wrapper
                .as_ref()
                .map(|w| !contains(SAME_SHELL_WRAPPERS, &w.kind))
                .unwrap_or(false);

            if let Some(w) = wrapper.as_ref() {
                if w.kind == "coproc" && self.coproc_name_before_compound(&raw, i, end) {
                    wrapper = None;
                    command_expected = true;
                    continue;
                }
            }

            let mut inline_consumed = false;
            if let Some(w) = wrapper.as_ref() {
                if option_value_for(WRAPPER_PATH_OPTIONS, &w.kind).is_some() {
                    for option in WRAPPER_PATH_OPTION_LONG {
                        if let Some(value) = raw.strip_prefix(option).and_then(|r| r.strip_prefix('=')) {
                            if let Some(replacement) = self.path_replacement(value) {
                                self.edits.push((
                                    word_start,
                                    word_end,
                                    format!("{option}={replacement}"),
                                ));
                                self.path_notes.push(raw.clone());
                            }
                            if let Some(w) = wrapper.as_mut() {
                                w.skip_next = false;
                                w.path_value = false;
                            }
                            command_expected = true;
                            inline_consumed = true;
                            break;
                        }
                    }
                }
            }
            if inline_consumed {
                continue;
            }

            if wrapper.is_some() {
                let path_option_value = wrapper
                    .as_ref()
                    .map(|w| w.path_value && w.skip_next)
                    .unwrap_or(false);
                let action = {
                    let w = wrapper.as_mut().expect("wrapper checked above");
                    self.consume_wrapper_word(w, &raw)
                };
                if action == "skip" {
                    if path_option_value {
                        if let Some(replacement) = self.path_replacement(&raw) {
                            self.edits.push((word_start, word_end, replacement));
                            self.path_notes.push(raw.clone());
                        }
                    }
                    command_expected = true;
                    continue;
                }
                if action == "inspect" {
                    command_expected = false;
                    wrapper = None;
                    continue;
                }
                if let Some(w) = wrapper.as_ref() {
                    if w.kind == "watch" {
                        self.watch_command_operand(word_start, word_end, &raw);
                        wrapper = None;
                    }
                }
            }

            if contains(COMMAND_WRAPPERS, &raw) {
                wrapper = Some(BashWrapper::new(&raw, wrapper_operand_count(&raw)));
                command_expected = true;
                continue;
            }
            let fallback_wrapper = FALLBACK_COMMAND_WRAPPERS
                .iter()
                .find(|(name, _)| *name == raw)
                .map(|(_, target)| *target);
            if let Some(fallback_wrapper) = fallback_wrapper {
                self.names.push(raw.clone());
                if executable_wrapper {
                    self.edits
                        .push((word_start, word_end, wrapper_runner(&raw)));
                }
                wrapper = Some(BashWrapper::new(
                    fallback_wrapper,
                    wrapper_operand_count(fallback_wrapper),
                ));
                command_expected = true;
                continue;
            }

            // Redundant shell invocation (`bash cd ...`, `bash -c '...'`):
            // only at a plain command position.
            let shell_name = Self::shell_wrapper_name(&raw);
            if let Some(shell_name) = shell_name {
                let handled = self.handle_shell_wrapper(
                    &shell_name,
                    word_start,
                    i,
                    end,
                    assignment_prefix,
                    wrapper.is_some(),
                );
                if let Some((next_i, keep_wrapper)) = handled {
                    i = next_i;
                    command_expected = true;
                    redirect_expected = false;
                    heredoc_operator = None;
                    if !keep_wrapper {
                        wrapper = None;
                    }
                    assignment_prefix = false;
                    continue;
                }
            }

            let fallback_name = Self::literal_command_name(&raw);
            if let Some(fallback_name) = fallback_name {
                self.names.push(fallback_name.clone());
                if executable_wrapper {
                    self.edits
                        .push((word_start, word_end, wrapper_runner(&fallback_name)));
                }
            } else {
                // A command word can itself be a Windows executable path
                // (`C:\tools\rg.exe`) or a Git Bash virtual absolute path
                // (`/c/tools/rg.exe`); Bash quote removal would eat the
                // backslashes and lose the command, so rewrite it like an
                // argument path.
                if let Some(replacement) = self.path_replacement(&raw) {
                    self.edits.push((word_start, word_end, replacement));
                    self.path_notes.push(raw);
                }
            }
            command_expected = false;
            wrapper = None;
        }
    }
}

fn wrapper_operand_count(kind: &str) -> usize {
    WRAPPER_OPERAND_COUNTS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, count)| *count)
        .unwrap_or(0)
}

// ---- low-level scanning helpers -------------------------------------------

fn find_byte(s: &str, needle: u8, from: usize) -> Option<usize> {
    s.as_bytes()[from..]
        .iter()
        .position(|&b| b == needle)
        .map(|p| from + p)
}

fn find_newline(s: &str, from: usize, end: usize) -> i64 {
    match find_byte(s, b'\n', from) {
        Some(p) if p < end => p as i64,
        _ => -1,
    }
}

impl BashFixScanner {
    fn starts_with(&self, pat: &str, at: usize) -> bool {
        at + pat.len() <= self.n
            && &self.s.as_bytes()[at..at + pat.len()] == pat.as_bytes()
    }

    /// Read a single shell word from *start*, returning the index after it.
    fn read_word(&mut self, start: usize, end: usize, scan_substitutions: bool) -> usize {
        let mut i = start;
        while i < end {
            let ch = self.s.as_bytes()[i];
            if WORD_END_CHARS.as_bytes().contains(&ch) {
                break;
            }
            if ch == b'#' && i == start {
                break;
            }
            if ch == b'\\' {
                i += if i + 1 < end { 2 } else { 1 };
                continue;
            }
            if ch == b'\'' {
                i = self.skip_single_quote(i + 1, end);
                continue;
            }
            if ch == b'"' {
                if scan_substitutions {
                    i = self.skip_double_quote(i + 1, end);
                } else {
                    i = self.skip_double_quote_for_matching(i + 1, end);
                }
                continue;
            }
            if ch == b'`' {
                let close = self.find_backtick_end(i + 1, end);
                if scan_substitutions {
                    self.scan_range(i + 1, close);
                }
                i = if close < end { close + 1 } else { end };
                continue;
            }
            if ch == b'$' {
                if self.starts_with("$((", i) {
                    i = self.skip_arithmetic(i + 3, end);
                    continue;
                }
                if self.starts_with("$(", i) {
                    let close = self.find_matching(i + 2, end, ")");
                    if scan_substitutions {
                        let inner_end = if close < end { close } else { end };
                        self.scan_range(i + 2, inner_end);
                    }
                    i = if close < end { close + 1 } else { end };
                    continue;
                }
                if self.starts_with("${", i) {
                    if scan_substitutions {
                        i = self.skip_parameter(i + 2, end);
                    } else {
                        i = self.skip_parameter_literal(i + 2, end);
                    }
                    continue;
                }
                if self.starts_with("$'", i) {
                    i = self.skip_ansi_quote(i + 2, end);
                    continue;
                }
            }
            i += 1;
        }
        i
    }

    fn skip_single_quote(&self, i: usize, end: usize) -> usize {
        match find_byte(&self.s, b'\'', i) {
            Some(close) if close < end => close + 1,
            _ => end,
        }
    }

    fn skip_ansi_quote(&self, i: usize, end: usize) -> usize {
        let s = self.s.as_bytes();
        let mut i = i;
        while i < end {
            if s[i] == b'\\' {
                i += if i + 1 < end { 2 } else { 1 };
            } else if s[i] == b'\'' {
                return i + 1;
            } else {
                i += 1;
            }
        }
        end
    }

    fn skip_double_quote(&mut self, i: usize, end: usize) -> usize {
        let mut i = i;
        while i < end {
            let ch = self.s.as_bytes()[i];
            if ch == b'\\'
                && i + 1 < end
                && matches!(self.s.as_bytes()[i + 1], b'$' | b'`' | b'"' | b'\\' | b'\n')
            {
                i += 2;
            } else if ch == b'"' {
                return i + 1;
            } else if ch == b'`' {
                let close = self.find_backtick_end(i + 1, end);
                self.scan_range(i + 1, close);
                i = if close < end { close + 1 } else { end };
            } else if ch == b'$' && self.starts_with("$(", i) && !self.starts_with("$((", i) {
                let close = self.find_matching(i + 2, end, ")");
                let inner_end = if close < end { close } else { end };
                self.scan_range(i + 2, inner_end);
                i = if close < end { close + 1 } else { end };
            } else if ch == b'$' && self.starts_with("${", i) {
                i = self.skip_parameter(i + 2, end);
            } else {
                i += 1;
            }
        }
        end
    }

    /// Scan array literal elements as data words.
    fn scan_array_words(&mut self, mut i: usize, end: usize) {
        while i < end {
            let ch = self.s.as_bytes()[i];
            if matches!(ch, b' ' | b'\t' | b'\r' | b'\n') {
                i += 1;
                continue;
            }
            if ch == b'\\' && i + 1 < end && self.s.as_bytes()[i + 1] == b'\n' {
                i += 2;
                continue;
            }
            if ch == b'#' && self.comment_starts(i, 0) {
                let newline = find_newline(&self.s, i + 1, end);
                i = if newline < 0 { end } else { newline as usize };
                continue;
            }
            let word_end = self.read_word(i, end, true);
            if word_end <= i {
                i += 1;
                continue;
            }
            let raw = &self.s[i..word_end];
            if let Some(replacement) = self.path_replacement(raw) {
                self.edits.push((i, word_end, replacement));
                self.path_notes.push(raw.to_string());
            }
            i = word_end;
        }
    }

    /// Scan substitutions in an expanding heredoc body.
    fn scan_heredoc_expansions(&mut self, mut i: usize, end: usize) {
        while i < end {
            let ch = self.s.as_bytes()[i];
            if ch == b'\\' {
                i += if i + 1 < end { 2 } else { 1 };
            } else if ch == b'`' {
                let close = self.find_backtick_end(i + 1, end);
                self.scan_range(i + 1, close);
                i = if close < end { close + 1 } else { end };
            } else if ch == b'$' && self.starts_with("$(", i) && !self.starts_with("$((", i) {
                let close = self.find_matching(i + 2, end, ")");
                let inner_end = if close < end { close } else { end };
                self.scan_range(i + 2, inner_end);
                i = if close < end { close + 1 } else { end };
            } else if ch == b'$' && self.starts_with("$((", i) {
                i = self.skip_arithmetic(i + 3, end);
            } else if ch == b'$' && self.starts_with("${", i) {
                i = self.skip_parameter(i + 2, end);
            } else {
                i += 1;
            }
        }
    }

    /// Skip a `[[ ... ]]` expression while scanning its substitutions.
    fn skip_conditional(&mut self, mut i: usize, end: usize) -> usize {
        while i < end {
            let ch = self.s.as_bytes()[i];
            if ch == b']' && self.starts_with("]]", i) {
                return i + 2;
            }
            if ch == b'\\' {
                i += if i + 1 < end { 2 } else { 1 };
            } else if ch == b'$' && self.starts_with("$'", i) {
                i = self.skip_ansi_quote(i + 2, end);
            } else if ch == b'\'' {
                i = self.skip_single_quote(i + 1, end);
            } else if ch == b'"' {
                i = self.skip_double_quote(i + 1, end);
            } else if ch == b'`' {
                let close = self.find_backtick_end(i + 1, end);
                self.scan_range(i + 1, close);
                i = if close < end { close + 1 } else { end };
            } else if ch == b'$' && self.starts_with("$(", i) && !self.starts_with("$((", i) {
                let close = self.find_matching(i + 2, end, ")");
                let inner_end = if close < end { close } else { end };
                self.scan_range(i + 2, inner_end);
                i = if close < end { close + 1 } else { end };
            } else if ch == b'$' && self.starts_with("$((", i) {
                i = self.skip_arithmetic(i + 3, end);
            } else {
                i += 1;
            }
        }
        end
    }

    fn skip_parameter_literal(&mut self, mut i: usize, end: usize) -> usize {
        let mut depth = 1usize;
        while i < end {
            let ch = self.s.as_bytes()[i];
            if ch == b'\\' {
                i += if i + 1 < end { 2 } else { 1 };
            } else if ch == b'\'' {
                i = self.skip_single_quote(i + 1, end);
            } else if ch == b'"' {
                i = self.skip_double_quote_for_matching(i + 1, end);
            } else if ch == b'{' {
                depth += 1;
                i += 1;
            } else if ch == b'}' {
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return i;
                }
            } else {
                i += 1;
            }
        }
        end
    }

    fn skip_parameter(&mut self, mut i: usize, end: usize) -> usize {
        let mut depth = 1usize;
        while i < end {
            let ch = self.s.as_bytes()[i];
            if ch == b'\\' {
                i += if i + 1 < end { 2 } else { 1 };
            } else if ch == b'$' && self.starts_with("$(", i) && !self.starts_with("$((", i) {
                let close = self.find_matching(i + 2, end, ")");
                let inner_end = if close < end { close } else { end };
                self.scan_range(i + 2, inner_end);
                i = if close < end { close + 1 } else { end };
            } else if ch == b'\'' {
                i = self.skip_single_quote(i + 1, end);
            } else if ch == b'"' {
                i = self.skip_double_quote(i + 1, end);
            } else if ch == b'{' {
                depth += 1;
                i += 1;
            } else if ch == b'}' {
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return i;
                }
            } else {
                i += 1;
            }
        }
        end
    }

    fn skip_arithmetic(&mut self, mut i: usize, end: usize) -> usize {
        let mut depth = 1usize;
        while i < end {
            let ch = self.s.as_bytes()[i];
            if ch == b'$' && self.starts_with("$(", i) && !self.starts_with("$((", i) {
                let close = self.find_matching(i + 2, end, ")");
                let inner_end = if close < end { close } else { end };
                self.scan_range(i + 2, inner_end);
                i = if close < end { close + 1 } else { end };
            } else if ch == b'(' && self.starts_with("((", i) {
                depth += 1;
                i += 2;
            } else if ch == b')' && self.starts_with("))", i) {
                depth -= 1;
                i += 2;
                if depth == 0 {
                    return i;
                }
            } else if ch == b'\\' {
                i += if i + 1 < end { 2 } else { 1 };
            } else if ch == b'\'' {
                i = self.skip_single_quote(i + 1, end);
            } else if ch == b'"' {
                i = self.skip_double_quote(i + 1, end);
            } else {
                i += 1;
            }
        }
        end
    }

    fn find_backtick_end(&self, mut i: usize, end: usize) -> usize {
        let s = self.s.as_bytes();
        while i < end {
            if s[i] == b'\\' {
                i += if i + 1 < end { 2 } else { 1 };
            } else if s[i] == b'`' {
                return i;
            } else {
                i += 1;
            }
        }
        end
    }

    /// Find the position of the bracket matching the one at `i - 2`.
    fn find_matching(&mut self, i: usize, end: usize, closing: &str) -> usize {
        if self.nest_depth >= MAX_NESTING_DEPTH {
            return end;
        }
        self.nest_depth += 1;
        let result = self.find_matching_inner(i, end, closing);
        self.nest_depth -= 1;
        result
    }

    fn find_matching_inner(&mut self, mut i: usize, end: usize, closing: &str) -> usize {
        let mut depth = 0usize;
        let mut pending_heredocs: Vec<BashHereDoc> = Vec::new();
        let mut case_stack: Vec<&'static str> = Vec::new();
        let closing_byte = closing.as_bytes()[0];
        while i < end {
            let ch = self.s.as_bytes()[i];
            if ch == b'\\' {
                i += if i + 1 < end { 2 } else { 1 };
            } else if ch == b'\n' {
                i += 1;
                if !pending_heredocs.is_empty() {
                    let mut docs = std::mem::take(&mut pending_heredocs);
                    i = self.skip_heredoc_bodies(i, end, &mut docs, false);
                }
            } else if ch == b'$' && self.starts_with("$((", i) {
                i = self.skip_arithmetic(i + 3, end);
                if case_stack.last() == Some(&"word") {
                    if let Some(top) = case_stack.last_mut() {
                        *top = "await-in";
                    }
                }
            } else if ch == b'<' && self.starts_with("<<", i) && !self.starts_with("<<<", i) {
                let strip_tabs = self.starts_with("<<-", i);
                let mut delimiter_start = i + if strip_tabs { 3 } else { 2 };
                while delimiter_start < end
                    && matches!(self.s.as_bytes()[delimiter_start], b' ' | b'\t' | b'\r')
                {
                    delimiter_start += 1;
                }
                let delimiter_end = self.read_word(delimiter_start, end, false);
                let heredoc = self.heredoc_delimiter(&self.s[delimiter_start..delimiter_end]);
                if let Some((delimiter, expands)) = heredoc {
                    pending_heredocs.push(BashHereDoc {
                        delimiter,
                        strip_tabs,
                        expands,
                    });
                }
                i = if delimiter_end > delimiter_start {
                    delimiter_end
                } else {
                    delimiter_start
                };
            } else if ch == b'\'' {
                i = self.skip_single_quote(i + 1, end);
            } else if ch == b'"' {
                i = self.skip_double_quote_for_matching(i + 1, end);
            } else if ch == b'`' {
                let close = self.find_backtick_end(i + 1, end);
                i = if close < end { close + 1 } else { end };
                if case_stack.last() == Some(&"word") {
                    if let Some(top) = case_stack.last_mut() {
                        *top = "await-in";
                    }
                }
            } else if ch == b'#' && self.comment_starts(i, 0) {
                let newline = find_newline(&self.s, i + 1, end);
                i = if newline < 0 { end } else { newline as usize };
            } else if ch == b';' && self.starts_with(";;&", i) {
                if !case_stack.is_empty() {
                    if let Some(top) = case_stack.last_mut() {
                        *top = "patterns";
                    }
                }
                i += 3;
            } else if ch == b';' && (self.starts_with(";;", i) || self.starts_with(";&", i)) {
                if !case_stack.is_empty() {
                    if let Some(top) = case_stack.last_mut() {
                        *top = "patterns";
                    }
                }
                i += 2;
            } else if !WORD_END_CHARS.as_bytes().contains(&ch) {
                let word_end = self.read_word(i, end, false);
                if word_end <= i {
                    i += 1;
                    continue;
                }
                let word = &self.s[i..word_end];
                if word == "case" {
                    case_stack.push("word");
                } else if !case_stack.is_empty()
                    && matches!(case_stack.last(), Some(&"patterns") | Some(&"body"))
                    && word == "esac"
                {
                    case_stack.pop();
                } else if case_stack.last() == Some(&"word") {
                    if let Some(top) = case_stack.last_mut() {
                        *top = "await-in";
                    }
                } else if case_stack.last() == Some(&"await-in") && word == "in" {
                    if let Some(top) = case_stack.last_mut() {
                        *top = "patterns";
                    }
                }
                i = word_end;
            } else if ch == b'(' {
                depth += 1;
                i += 1;
            } else if ch == closing_byte {
                if case_stack.last() == Some(&"patterns") {
                    if let Some(top) = case_stack.last_mut() {
                        *top = "body";
                    }
                    i += 1;
                } else if depth == 0 {
                    return i;
                } else {
                    depth -= 1;
                    i += 1;
                }
            } else {
                i += 1;
            }
        }
        end
    }

    fn skip_double_quote_for_matching(&mut self, mut i: usize, end: usize) -> usize {
        while i < end {
            let ch = self.s.as_bytes()[i];
            if ch == b'\\'
                && i + 1 < end
                && matches!(self.s.as_bytes()[i + 1], b'$' | b'`' | b'"' | b'\\' | b'\n')
            {
                i += 2;
            } else if ch == b'"' {
                return i + 1;
            } else if ch == b'`' {
                let close = self.find_backtick_end(i + 1, end);
                i = if close < end { close + 1 } else { end };
            } else if ch == b'$' && self.starts_with("$(", i) && !self.starts_with("$((", i) {
                let close = self.find_matching(i + 2, end, ")");
                i = if close < end { close + 1 } else { end };
            } else {
                i += 1;
            }
        }
        end
    }

    fn read_control_operator(&self, i: usize, _end: usize) -> (&'static str, usize) {
        let ch = self.s.as_bytes()[i];
        if ch == b';' {
            if self.starts_with(";;&", i) {
                return (";;&", i + 3);
            }
            if self.starts_with(";;", i) {
                return (";;", i + 2);
            }
            if self.starts_with(";&", i) {
                return (";&", i + 2);
            }
            return (";", i + 1);
        }
        if ch == b'&' {
            if self.starts_with("&&", i) {
                return ("&&", i + 2);
            }
            return ("&", i + 1);
        }
        if ch == b'|' {
            if self.starts_with("||", i) {
                return ("||", i + 2);
            }
            if self.starts_with("|&", i) {
                return ("|&", i + 2);
            }
            return ("|", i + 1);
        }
        if ch == b'(' || ch == b')' {
            return (if ch == b'(' { "(" } else { ")" }, i + 1);
        }
        ("", i)
    }

    fn read_redirection(&self, i: usize, _end: usize) -> (String, usize) {
        for op in ["&>>", "&>", "<<<", "<<-", "<<", ">>", "<>", ">|", "<&", ">&", "<", ">"] {
            if self.starts_with(op, i) {
                return (op.to_string(), i + op.len());
            }
        }
        (String::new(), i)
    }

    fn redirection_after_fd(&self, mut i: usize, end: usize) -> bool {
        let s = self.s.as_bytes();
        while i < end && s[i].is_ascii_digit() {
            i += 1;
        }
        i < end && REDIRECTION_START.as_bytes().contains(&s[i])
    }

    fn comment_starts(&self, i: usize, range_start: usize) -> bool {
        if i <= range_start {
            return true;
        }
        let s = self.s.as_bytes();
        let prev = s[i - 1];
        matches!(
            prev,
            b' ' | b'\t' | b'\r' | b'\n' | b';' | b'&' | b'|' | b'(' | b')' | b'<' | b'>'
        )
    }

    fn empty_parentheses_end(&self, mut i: usize, end: usize) -> Option<usize> {
        let s = self.s.as_bytes();
        while i < end && matches!(s[i], b' ' | b'\t' | b'\r') {
            i += 1;
        }
        if i >= end || s[i] != b'(' {
            return None;
        }
        i += 1;
        while i < end && matches!(s[i], b' ' | b'\t' | b'\r') {
            i += 1;
        }
        if i < end && s[i] == b')' {
            Some(i + 1)
        } else {
            None
        }
    }

    fn function_declaration_end(&self, raw: &str, i: usize, end: usize) -> Option<usize> {
        if !is_name(raw) {
            return None;
        }
        self.empty_parentheses_end(i, end)
    }

    fn consume_wrapper_word(&mut self, wrapper: &mut BashWrapper, raw: &str) -> &'static str {
        if wrapper.skip_next {
            wrapper.skip_next = false;
            if wrapper.opaque {
                return "inspect";
            }
            return "skip";
        }
        if wrapper.opaque {
            return "inspect";
        }
        if wrapper.operands > 0 && !raw.starts_with('-') {
            // A plain operand before the command word (GNU `timeout` takes
            // exactly one DURATION operand) is wrapper data, not the wrapped
            // command; consume it without ending the wrapper.
            wrapper.operands -= 1;
            return "skip";
        }
        if wrapper.kind == "command" && (raw == "-v" || raw == "-V") {
            return "inspect";
        }
        if wrapper.kind == "command"
            && (raw == "-p"
                || (raw.starts_with('-') && !raw.starts_with("--") && raw[1..].contains('p')))
        {
            wrapper.opaque = true;
            return "skip";
        }
        if wrapper.kind == "env" && (raw == "-S" || raw == "--split-string") {
            wrapper.opaque = true;
            wrapper.skip_next = true;
            return "skip";
        }
        if wrapper.kind == "env"
            && (raw.starts_with("--split-string=") || (raw.starts_with("-S") && raw != "-S"))
        {
            return "inspect";
        }
        if raw == "--" {
            return "skip";
        }
        if contains_option(WRAPPER_OPTIONS_WITH_VALUE, &wrapper.kind, raw) {
            wrapper.skip_next = true;
            if contains_option(WRAPPER_PATH_OPTIONS, &wrapper.kind, raw) {
                wrapper.path_value = true;
            }
            return "skip";
        }
        if raw.starts_with('-') {
            return "skip";
        }
        if wrapper.kind == "env" && is_assignment(raw) {
            return "skip";
        }
        "command"
    }

    fn coproc_name_before_compound(&self, raw: &str, mut i: usize, end: usize) -> bool {
        if !is_name(raw) {
            return false;
        }
        let s = self.s.as_bytes();
        while i < end && matches!(s[i], b' ' | b'\t' | b'\r') {
            i += 1;
        }
        if i >= end {
            return false;
        }
        if self.starts_with("{", i)
            || self.starts_with("(", i)
            || self.starts_with("[[", i)
            || self.starts_with("((", i)
        {
            return true;
        }
        for keyword in ["case", "for", "if", "select", "until", "while"] {
            let keyword_end = i + keyword.len();
            if self.starts_with(keyword, i)
                && (keyword_end >= end
                    || matches!(
                        s[keyword_end],
                        b' ' | b'\t' | b'\r' | b'\n' | b';' | b'&' | b'|' | b'(' | b')' | b'<'
                            | b'>' | b'{' | b'}'
                    ))
            {
                return true;
            }
        }
        false
    }
}

// ---- heredoc handling ------------------------------------------------------

impl BashFixScanner {
    fn heredoc_delimiter(&self, raw: &str) -> Option<(Option<String>, bool)> {
        if raw.is_empty() {
            return None;
        }
        let bytes = raw.as_bytes();
        let mut result: Vec<u8> = Vec::new();
        let mut quoted = false;
        let mut matchable = true;
        let mut i = 0;
        while i < bytes.len() {
            let ch = bytes[i];
            if raw[i..].starts_with("$'") {
                quoted = true;
                let (value, next_i, valid) = self.read_ansi_c_delimiter(raw, i + 2);
                result.extend(value.as_bytes());
                matchable = matchable && valid;
                i = next_i;
            } else if ch == b'\'' {
                quoted = true;
                match find_byte(raw, b'\'', i + 1) {
                    None => {
                        result.extend_from_slice(&bytes[i + 1..]);
                        i = bytes.len();
                    }
                    Some(close) => {
                        result.extend_from_slice(&bytes[i + 1..close]);
                        i = close + 1;
                    }
                }
            } else if ch == b'"' {
                quoted = true;
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    if bytes[i] == b'\\' && i + 1 < bytes.len() {
                        let escaped = bytes[i + 1];
                        if matches!(escaped, b'$' | b'`' | b'"' | b'\\' | b'\n') {
                            if escaped != b'\n' {
                                result.push(escaped);
                            }
                            i += 2;
                            continue;
                        }
                    }
                    result.push(bytes[i]);
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1;
                }
            } else if ch == b'\\' && i + 1 < bytes.len() {
                quoted = true;
                result.push(bytes[i + 1]);
                i += 2;
            } else {
                result.push(ch);
                i += 1;
            }
        }
        let delimiter = if matchable {
            String::from_utf8(result).ok()
        } else {
            None
        };
        Some((delimiter, !quoted))
    }

    fn read_ansi_c_delimiter(&self, raw: &str, mut i: usize) -> (String, usize, bool) {
        let bytes = raw.as_bytes();
        let mut result: Vec<u8> = Vec::new();
        let mut valid = true;
        while i < bytes.len() {
            if bytes[i] == b'\'' {
                return (String::from_utf8(result).unwrap_or_default(), i + 1, valid);
            }
            if bytes[i] != b'\\' || i + 1 >= bytes.len() {
                result.push(bytes[i]);
                i += 1;
                continue;
            }
            let escape = bytes[i + 1];
            let simple = match escape {
                b'a' => Some(b'\x07'),
                b'b' => Some(b'\x08'),
                b'e' | b'E' => Some(b'\x1b'),
                b'f' => Some(b'\x0c'),
                b'n' => Some(b'\n'),
                b'r' => Some(b'\r'),
                b't' => Some(b'\t'),
                b'v' => Some(b'\x0b'),
                b'\\' => Some(b'\\'),
                b'\'' => Some(b'\''),
                b'"' => Some(b'"'),
                b'?' => Some(b'?'),
                _ => None,
            };
            if let Some(simple) = simple {
                result.push(simple);
                i += 2;
                continue;
            }
            if (b'0'..=b'7').contains(&escape) {
                let mut j = i + 1;
                while j < bytes.len() && j < i + 4 && (b'0'..=b'7').contains(&bytes[j]) {
                    j += 1;
                }
                if let Ok(value) = u32::from_str_radix(&raw[i + 1..j], 8) {
                    result.push(value as u8);
                }
                i = j;
                continue;
            }
            if matches!(escape, b'x' | b'X' | b'u' | b'U') {
                let width = match escape {
                    b'x' | b'X' => 2usize,
                    b'u' => 4,
                    _ => 8,
                };
                let mut j = i + 2;
                let limit = bytes.len().min(j + width);
                while j < limit && bytes[j].is_ascii_hexdigit() {
                    j += 1;
                }
                if j > i + 2 {
                    if let Ok(value) = u32::from_str_radix(&raw[i + 2..j], 16) {
                        if value <= 0x10FFFF && !(0xD800..=0xDFFF).contains(&value) {
                            if let Some(ch) = char::from_u32(value) {
                                result.extend(ch.to_string().as_bytes());
                            } else {
                                valid = false;
                                result.extend_from_slice(&bytes[i..j]);
                            }
                        } else {
                            // Bash accepts byte sequences outside Python's
                            // Unicode scalar range.  Mark it unmatchable and
                            // conservatively keep the source inside the heredoc.
                            valid = false;
                            result.extend_from_slice(&bytes[i..j]);
                        }
                        i = j;
                        continue;
                    }
                }
            }
            result.push(b'\\');
            result.push(escape);
            i += 2;
        }
        (String::from_utf8(result).unwrap_or_default(), i, valid)
    }

    fn skip_heredoc_bodies(
        &mut self,
        mut i: usize,
        end: usize,
        documents: &mut [BashHereDoc],
        scan_expansions: bool,
    ) -> usize {
        let mut redir_line_end: i64 = -1;
        for document in documents.iter() {
            let body_start = i;
            if redir_line_end < 0 {
                redir_line_end = body_start as i64 - 1;
            }
            let mut logical_line = String::new();
            let mut logical_start = i;
            let mut found = false;
            while i < end {
                let newline = find_byte(&self.s, b'\n', i);
                let line_end = match newline {
                    Some(p) if p < end => p,
                    _ => end,
                };
                let line = self.s[i..line_end].to_string();
                let compare: &str = if document.strip_tabs {
                    line.trim_start_matches('\t')
                } else {
                    &line
                };
                if logical_line.is_empty() {
                    logical_start = i;
                }
                if document.expands && Self::heredoc_line_continues(compare) {
                    logical_line.push_str(&compare[..compare.len() - 1]);
                    i = match newline {
                        Some(p) if p < end => p + 1,
                        _ => end,
                    };
                    continue;
                }
                logical_line.push_str(compare);
                if let Some(delimiter) = document.delimiter.as_deref() {
                    if logical_line == delimiter {
                        if scan_expansions && document.expands {
                            self.scan_heredoc_expansions(body_start, logical_start);
                        }
                        i = match newline {
                            Some(p) if p < end => p + 1,
                            _ => end,
                        };
                        found = true;
                        break;
                    }
                }
                logical_line.clear();
                i = match newline {
                    Some(p) if p < end => p + 1,
                    _ => end,
                };
            }
            if !found && scan_expansions && document.expands {
                self.scan_heredoc_expansions(body_start, end);
            }
        }
        if redir_line_end >= 0 {
            self.heredoc_events.push((redir_line_end as usize, i));
        }
        i
    }

    fn heredoc_line_continues(line: &str) -> bool {
        let trailing = line.len() - line.trim_end_matches('\\').len();
        trailing % 2 == 1
    }

    // ---- Windows path normalization for Git Bash ---------------------------

    /// Drop the cmd.exe-only `cd /d <path>` flag form.
    fn drop_cmd_cd_flag(&mut self, i: usize, end: usize) {
        let mut j = i;
        while j < end && matches!(self.s.as_bytes()[j], b' ' | b'\t' | b'\r') {
            j += 1;
        }
        if j >= end {
            return;
        }
        let flag_end = self.read_word(j, end, false);
        if flag_end <= j || (&self.s[j..flag_end] != "/d" && &self.s[j..flag_end] != "/D") {
            return;
        }
        let mut k = flag_end;
        while k < end && matches!(self.s.as_bytes()[k], b' ' | b'\t' | b'\r') {
            k += 1;
        }
        if k >= end || OPERATOR_CHARS.as_bytes().contains(&self.s.as_bytes()[k]) || self.s.as_bytes()[k] == b'#' {
            return;
        }
        self.edits.push((j, flag_end, String::new()));
        self.path_notes.push("cd /d".to_string());
    }

    /// Return the Git Bash spelling of a Windows backslash path word.
    fn windows_path_replacement(&self, raw: &str) -> Option<String> {
        if raw.is_empty() || !raw.contains('\\') {
            return None;
        }
        let bytes = raw.as_bytes();
        let mut backslashes = 0usize;
        for &ch in bytes {
            if ch == b'\\' {
                backslashes += 1;
            } else if matches!(ch, b'\'' | b'"' | b'`' | b'$' | b'\n' | b'\r') {
                return None;
            }
        }
        if is_drive_abs(raw) {
            // pass
        } else if raw.starts_with("\\\\") && raw.len() > 2 {
            // pass
        } else if raw.starts_with('\\') && !raw.starts_with("\\\\") && backslashes >= 2 {
            if !Self::plausible_path_segments(raw) {
                return None;
            }
        } else if raw.starts_with("~\\") {
            // pass
        } else if raw.starts_with(".\\") || raw.starts_with("..\\") {
            // pass
        } else if backslashes >= 2 {
            let decoded = Self::decode_unquoted_word(raw);
            if decoded.len() < 2
                || !decoded.bytes().any(|b| b.is_ascii_alphanumeric())
                || !is_path_segment_word(&decoded)
                || !Self::plausible_path_segments(raw)
            {
                return None;
            }
        } else {
            return None;
        }
        Some(self.quote_path_word(&Self::normalize_windows_path(raw)))
    }

    /// Return the native Windows spelling of a Git Bash virtual absolute path.
    fn git_bash_abs_path_replacement(&self, raw: &str) -> Option<String> {
        if raw.is_empty() {
            return None;
        }
        if raw.starts_with("/tmp") {
            if raw != "/tmp" && !raw.starts_with("/tmp/") {
                return None;
            }
            return Some(self.quote_path_word(&(windows_temp_dir() + &raw[4..])));
        }
        let bytes = raw.as_bytes();
        if bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b'/'
        {
            let drive = (bytes[1] as char).to_ascii_uppercase();
            return Some(self.quote_path_word(&format!("{drive}:{}", &raw[2..])));
        }
        None
    }

    /// Return the Git Bash spelling for a Windows path word.
    fn path_replacement(&self, raw: &str) -> Option<String> {
        self.windows_path_replacement(raw)
            .or_else(|| self.git_bash_abs_path_replacement(raw))
    }

    /// Require at least one segment that looks like a real directory name.
    fn plausible_path_segments(raw: &str) -> bool {
        raw.split('\\')
            .any(|segment| segment.len() >= 2 && segment.as_bytes()[0].is_ascii_alphabetic())
    }

    /// Return the word value after Bash quote removal (unquoted form).
    fn decode_unquoted_word(raw: &str) -> String {
        let bytes = raw.as_bytes();
        let mut value: Vec<u8> = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            let ch = bytes[i];
            if ch == b'\\' && i + 1 < bytes.len() {
                value.push(bytes[i + 1]);
                i += 2;
            } else {
                value.push(ch);
                i += 1;
            }
        }
        String::from_utf8(value).unwrap_or_default()
    }

    /// Rewrite backslashes as the forward slashes Git Bash understands.
    fn normalize_windows_path(raw: &str) -> String {
        let bytes = raw.as_bytes();
        let mut out: Vec<u8> = Vec::new();
        let mut i = 0;
        let n = bytes.len();
        if n >= 2 && raw.starts_with("\\\\") {
            out.extend_from_slice(b"//");
            i = 2;
        }
        while i < n {
            let ch = bytes[i];
            if ch == b'\\' && i + 1 < n {
                let nxt = bytes[i + 1];
                if nxt == b'\\' {
                    out.push(b'/');
                } else if ESCAPED_LITERAL_CHARS.as_bytes().contains(&nxt) {
                    out.push(nxt);
                } else {
                    out.push(b'/');
                    out.push(nxt);
                }
                i += 2;
            } else if ch == b'\\' {
                out.push(b'/');
                i += 1;
            } else {
                out.push(ch);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap_or_default()
    }

    /// Quote a normalized path only when unquoted emission would break it.
    fn quote_path_word(&self, normalized: &str) -> String {
        if normalized
            .bytes()
            .all(|ch| PATH_SAFE_CHARS.as_bytes().contains(&ch))
        {
            return normalized.to_string();
        }
        if let Some(rest) = normalized.strip_prefix('~') {
            return format!("~{}", self.quote_path_word(rest));
        }
        let escaped = normalized
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('$', "\\$")
            .replace('`', "\\`");
        format!("\"{escaped}\"")
    }
}

// =====================================================================
// Public API
// =====================================================================

/// Return exported fallback definitions for a persistent Git Bash shell.
///
/// Interactive input can be an incomplete Bash fragment (for example a
/// heredoc body or the second half of a quote), so it must never be scanned
/// and prefixed independently.  The interactive shell instead executes this
/// prelude once and exports the fallback functions across `exec bash -i`.
/// On non-Windows platforms this returns an empty string.
pub fn bash_compatibility_prelude() -> String {
    if !cfg!(target_os = "windows") {
        return String::new();
    }
    let definitions: Vec<&str> = FALLBACK_BODIES
        .iter()
        .map(|(name, _)| fallback_definition(name))
        .collect();
    let exports: Vec<String> = FALLBACK_BODIES
        .iter()
        .map(|(name, _)| format!("if declare -F {name} >/dev/null; then export -f {name}; fi"))
        .collect();
    definitions.join("\n") + "\n" + &exports.join("\n")
}

fn read_shell_control_operator(s: &str, i: usize, n: usize) -> (&'static str, usize) {
    if i >= n {
        return ("", i);
    }
    let ch = s.as_bytes()[i];
    if ch == b';' {
        if s[i..].starts_with(";;&") {
            return (";;&", i + 3);
        }
        if s[i..].starts_with(";;") {
            return (";;", i + 2);
        }
        if s[i..].starts_with(";&") {
            return (";&", i + 2);
        }
        return (";", i + 1);
    }
    if ch == b'&' {
        if s[i..].starts_with("&&") {
            return ("&&", i + 2);
        }
        return ("&", i + 1);
    }
    if ch == b'|' {
        if s[i..].starts_with("||") {
            return ("||", i + 2);
        }
        if s[i..].starts_with("|&") {
            return ("|&", i + 2);
        }
        return ("|", i + 1);
    }
    ("", i)
}

/// Move a control-operator line following a heredoc terminator to the
/// redirection line.
fn apply_heredoc_operator_move(source: &str, redir_line_end: usize, terminator_end: usize) -> String {
    let n = source.len();
    if redir_line_end >= n || source.as_bytes()[redir_line_end] != b'\n' {
        return source.to_string();
    }
    if terminator_end > n {
        return source.to_string();
    }
    let mut i = terminator_end;
    while i < n {
        let ch = source.as_bytes()[i];
        if matches!(ch, b' ' | b'\t' | b'\r') {
            i += 1;
            continue;
        }
        if ch == b'\n' {
            i += 1;
            continue;
        }
        if ch == b'#' {
            let nl = find_newline(source, i, n);
            i = if nl < 0 { n } else { nl as usize + 1 };
            continue;
        }
        break;
    }
    if i >= n {
        return source.to_string();
    }
    let (op, op_end) = read_shell_control_operator(source, i, n);
    if !contains(HEREDOC_TRAILING_OPERATORS, op) {
        return source.to_string();
    }
    // `&>` / `&>>` are redirections, not list terminators.
    if op == "&" && op_end < n && source.as_bytes()[op_end] == b'>' {
        return source.to_string();
    }
    let move_start = i;
    let line_end = find_newline(source, i, n);
    let (mut move_end, rest) = if line_end < 0 {
        (n, source[op_end..n].trim_start_matches([' ', '\t', '\r']).to_string())
    } else {
        let le = line_end as usize;
        (le + 1, source[op_end..le].trim_start_matches([' ', '\t', '\r']).to_string())
    };
    if rest.is_empty() || rest.starts_with('#') {
        let mut k = move_end;
        while k < n {
            let ch = source.as_bytes()[k];
            if matches!(ch, b' ' | b'\t' | b'\r') {
                k += 1;
                continue;
            }
            if ch == b'\n' {
                k += 1;
                continue;
            }
            if ch == b'#' {
                let nl = find_newline(source, k, n);
                k = if nl < 0 { n } else { nl as usize + 1 };
                continue;
            }
            break;
        }
        if k >= n {
            return source.to_string();
        }
        let next_line_end = find_newline(source, k, n);
        move_end = if next_line_end < 0 { n } else { next_line_end as usize + 1 };
    }
    let lines: Vec<&str> = source[move_start..move_end].lines().collect();
    let mut parts: Vec<&str> = Vec::new();
    if let Some(first) = lines.first() {
        parts.push(first[op.len()..].trim());
        parts.extend(lines[1..].iter().map(|l| l.trim()));
    }
    let joined: Vec<&str> = parts
        .into_iter()
        .filter(|part| !part.is_empty() && !part.starts_with('#'))
        .collect();
    let moved = if joined.is_empty() {
        format!("{op}\n")
    } else {
        format!("{op} {}\n", joined.join(" "))
    };
    let mut out = String::new();
    out.push_str(&source[..redir_line_end]);
    out.push(' ');
    out.push_str(&moved);
    out.push_str(&source[redir_line_end + 1..move_start]);
    out.push_str(&source[move_end..]);
    out
}

/// Repair heredoc commands whose trailing control operator is on the wrong line.
fn fix_heredoc_trailing_operators(source: &str) -> String {
    let mut scanner = BashFixScanner::new(source);
    scanner.scan_range(0, scanner.n);
    if scanner.heredoc_events.is_empty() {
        return source.to_string();
    }
    let mut result = source.to_string();
    for (redir_line_end, terminator_end) in scanner.heredoc_events.iter().rev() {
        result = apply_heredoc_operator_move(&result, *redir_line_end, *terminator_end);
    }
    result
}

/// Rewrite selected native POSIX commands for Windows Git Bash.
///
/// The Windows-platform gate lives in the caller (matching
/// `kimix.tools.file.bash.bash_fix.fix_bash_command`); this scanner itself
/// does not gate on platform.  Empty input is returned byte-for-byte
/// unchanged.
pub fn fix_bash_command(command: &str) -> BashFix {
    if command.is_empty() {
        return BashFix::unchanged(command.to_string());
    }
    let result = BashFixScanner::new(command).fix();
    let fixed = fix_heredoc_trailing_operators(&result.command);
    BashFix {
        command: fixed,
        replacements: result.replacements,
        path_changes: result.path_changes,
        shell_wrappers: result.shell_wrappers,
    }
}

// =====================================================================
// `_process_unquoted` port from bash_tool.py
// =====================================================================

const BASH_METACHARACTERS: &str = "()|;&<>$\"`'*?[]{}~!#=% \t\n\r";
const DQ_ESCAPED: &str = "\"\\$`";

fn find_ansi_c_end(cmd: &str, start: usize) -> Option<usize> {
    let bytes = cmd.as_bytes();
    let mut i = start;
    let length = bytes.len();
    while i < length {
        let c = bytes[i];
        if c == b'\\' && i + 1 < length {
            i += 2;
        } else if c == b'\'' {
            return Some(i + 1);
        } else {
            i += 1;
        }
    }
    None
}

fn find_backtick_end(cmd: &str, start: usize) -> Option<usize> {
    let bytes = cmd.as_bytes();
    let mut i = start;
    let length = bytes.len();
    while i < length {
        let c = bytes[i];
        if c == b'\\' && i + 1 < length {
            i += 2;
        } else if c == b'`' {
            return Some(i + 1);
        } else {
            i += 1;
        }
    }
    None
}

/// Return the index after the `)` matching the `(` at `cmd[open_pos]`.
fn find_matching_paren(cmd: &str, open_pos: usize) -> Option<usize> {
    let bytes = cmd.as_bytes();
    debug_assert_eq!(bytes[open_pos], b'(');
    let mut depth = 1usize;
    let mut i = open_pos + 1;
    let length = bytes.len();
    while i < length {
        let c = bytes[i];
        if c == b'\'' {
            let end = find_byte(cmd, b'\'', i + 1)?;
            i = end + 1;
        } else if c == b'"' {
            i = find_dq_end(cmd, i + 1)?;
        } else if c == b'`' {
            i = find_backtick_end(cmd, i + 1)?;
        } else if c == b'$' && i + 1 < length && bytes[i + 1] == b'(' {
            depth += 1;
            i += 2;
        } else if c == b'$' && i + 1 < length && bytes[i + 1] == b'\'' {
            let end = find_ansi_c_end(cmd, i + 2)?;
            i = end;
        } else if c == b')' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
            i += 1;
        } else {
            i += 1;
        }
    }
    None
}

/// Return the index after the closing `"` of a double-quoted region.
fn find_dq_end(cmd: &str, start: usize) -> Option<usize> {
    let bytes = cmd.as_bytes();
    let mut i = start;
    let length = bytes.len();
    while i < length {
        let c = bytes[i];
        if c == b'\\' && i + 1 < length && DQ_ESCAPED.as_bytes().contains(&bytes[i + 1]) {
            i += 2;
        } else if c == b'"' {
            return Some(i + 1);
        } else if c == b'$' && i + 1 < length && bytes[i + 1] == b'(' {
            i = find_matching_paren(cmd, i + 1)? + 1;
        } else if c == b'$' && i + 1 < length && bytes[i + 1] == b'\'' {
            i = find_ansi_c_end(cmd, i + 2)?;
        } else if c == b'`' {
            i = find_backtick_end(cmd, i + 1)?;
        } else {
            i += 1;
        }
    }
    None
}

/// Convert unquoted backslashes to forward slashes in `cmd`.
///
/// Walks the string in *unquoted mode* (the same rules that apply at the top
/// level of a bash command): a bare `\` followed by a non-metachar is
/// converted to `/`, while `\` followed by a bash metacharacter, or `\`
/// inside single / double / ANSI-C quotes, is preserved.  The function also
/// descends into `$(...)` and backtick command substitutions, processing
/// their content in unquoted mode as well.
pub fn process_unquoted(cmd: &str) -> String {
    let bytes = cmd.as_bytes();
    let mut result: Vec<u8> = Vec::new();
    let mut i = 0;
    let length = bytes.len();

    while i < length {
        // Find the next special character: backslash, quote, dollar, backtick.
        let mut nxt: Option<usize> = None;
        for j in i..length {
            if matches!(bytes[j], b'\\' | b'\'' | b'"' | b'$' | b'`') {
                nxt = Some(j);
                break;
            }
        }
        match nxt {
            Some(j) => {
                if j > i {
                    result.extend_from_slice(&bytes[i..j]);
                    i = j;
                }
            }
            None => {
                result.extend_from_slice(&bytes[i..]);
                break;
            }
        }
        if i >= length {
            break;
        }

        let char = bytes[i];
        if char == b'\'' {
            let Some(end) = find_byte(cmd, b'\'', i + 1) else {
                result.extend_from_slice(&bytes[i..]);
                break;
            };
            result.extend_from_slice(&bytes[i..=end]);
            i = end + 1;
        } else if char == b'"' {
            let Some(dq_end) = find_dq_end(cmd, i + 1) else {
                result.extend_from_slice(&bytes[i..]);
                break;
            };
            let mut j = i + 1;
            let mut chunk_start = i;
            while j < dq_end {
                let mut nxt2: Option<usize> = None;
                for k in j..dq_end {
                    if matches!(bytes[k], b'\\' | b'$' | b'`') {
                        nxt2 = Some(k);
                        break;
                    }
                }
                match nxt2 {
                    Some(k) => {
                        if k > j {
                            j = k;
                        }
                    }
                    None => {
                        break;
                    }
                }
                let c = bytes[j];
                if c == b'\\' && j + 1 < dq_end && DQ_ESCAPED.as_bytes().contains(&bytes[j + 1]) {
                    j += 2;
                } else if c == b'$' && j + 1 < dq_end && bytes[j + 1] == b'(' {
                    match find_matching_paren(cmd, j + 1) {
                        Some(paren_end) if paren_end < dq_end => {
                            result.extend_from_slice(&bytes[chunk_start..j]);
                            result.push(b'$');
                            result.push(b'(');
                            result.extend(process_unquoted(&cmd[j + 2..paren_end]).into_bytes());
                            result.push(b')');
                            j = paren_end + 1;
                            chunk_start = j;
                        }
                        _ => {
                            break;
                        }
                    }
                } else if c == b'$' && j + 1 < dq_end && bytes[j + 1] == b'\'' {
                    match find_ansi_c_end(cmd, j + 2) {
                        Some(ac_end) if ac_end <= dq_end => {
                            j = ac_end;
                        }
                        _ => {
                            break;
                        }
                    }
                } else if c == b'`' {
                    match find_backtick_end(cmd, j + 1) {
                        Some(bt_end) if bt_end <= dq_end => {
                            result.extend_from_slice(&bytes[chunk_start..j]);
                            result.push(b'`');
                            result.extend(process_unquoted(&cmd[j + 1..bt_end - 1]).into_bytes());
                            result.push(b'`');
                            j = bt_end;
                            chunk_start = j;
                        }
                        _ => {
                            break;
                        }
                    }
                } else {
                    j += 1;
                }
            }
            result.extend_from_slice(&bytes[chunk_start..dq_end]);
            i = dq_end;
        } else if char == b'$' && i + 1 < length && bytes[i + 1] == b'\'' {
            let Some(ac_end) = find_ansi_c_end(cmd, i + 2) else {
                result.extend_from_slice(&bytes[i..]);
                break;
            };
            result.extend_from_slice(&bytes[i..ac_end]);
            i = ac_end;
        } else if char == b'`' {
            let Some(bt_end) = find_backtick_end(cmd, i + 1) else {
                result.extend_from_slice(&bytes[i..]);
                break;
            };
            result.push(b'`');
            result.extend(process_unquoted(&cmd[i + 1..bt_end - 1]).into_bytes());
            result.push(b'`');
            i = bt_end;
        } else if char == b'\\' {
            if i + 1 < length && BASH_METACHARACTERS.as_bytes().contains(&bytes[i + 1]) {
                result.push(b'\\');
                result.push(bytes[i + 1]);
                i += 2;
            } else {
                result.push(b'/');
                i += 1;
            }
        } else {
            result.push(char);
            i += 1;
        }
    }
    String::from_utf8(result).expect("process_unquoted keeps valid UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn fix(command: &str) -> BashFix {
        fix_bash_command(command)
    }

    fn last_line(command: &str) -> &str {
        command.rsplit('\n').next().unwrap_or(command)
    }

    #[test]
    fn unchanged_result() {
        let result = fix("echo ok");
        assert_eq!(result.command, "echo ok");
        assert!(result.replacements.is_empty());
        assert!(result.path_changes.is_empty());
        assert!(result.shell_wrappers.is_empty());
        assert!(!result.changed());
        assert_eq!(result.warning(), "");
    }

    #[test]
    fn empty_and_plain_inputs_round_trip() {
        for command in ["", " ", "\t\n", "echo ok\n"] {
            assert_eq!(fix(command).command, command);
        }
    }

    #[test]
    fn fallback_rewrites_command_word() {
        // `rev` gets a definition prefix; the source word is kept and resolves
        // to the fallback function inside the shell.
        let result = fix("rev");
        assert_eq!(last_line(&result.command), "rev");
        assert_eq!(result.replacements, vec!["rev".to_string()]);
        assert!(result.command.starts_with("if ! command -v rev"));
        assert!(result.command.contains("export -f rev"));
        assert!(result.changed());
        assert!(result.warning().contains("rev"));
    }

    #[test]
    fn multiple_rewrites_preserve_order() {
        let result = fix("gtimeout 1 true; printf x | rev");
        assert_eq!(result.replacements, vec!["gtimeout".to_string(), "rev".to_string()]);
    }

    #[test]
    fn git_bash_bundled_commands_are_not_rewritten() {
        for command in [
            "timeout 1 true",
            "stdbuf -oL echo ok",
            "mktemp",
            "sed -n 1p file",
            "grep value file",
            "xargs echo",
            "tac file",
            "find . -name '*.py'",
        ] {
            assert_eq!(fix(command), BashFix::unchanged(command.to_string()), "for {command:?}");
        }
    }

    #[test]
    fn commands_without_faithful_mapping_are_preserved() {
        for command in [
            "setsid app",
            "flock lockfile app",
            "lsof file",
            "systemctl status service",
            "apt update",
            "sudo command",
        ] {
            assert_eq!(fix(command), BashFix::unchanged(command.to_string()), "for {command:?}");
        }
    }

    #[test]
    fn rewrites_only_executable_command_words() {
        // The scanner records the fallback name; the fixed command keeps the
        // source word (the prepended definition makes it resolve to the
        // fallback function inside the shell).
        let cases = [
            "rev",
            "true; rev",
            "true && rev",
            "printf x | rev",
            "(rev)",
            "if rev; then echo yes; fi",
            "result=$(rev)",
            "echo `rev`",
            "FOO=bar rev",
            ">output rev",
            "command rev",
            "env rev",
            "nohup rev",
            "time rev",
        ];
        for source in cases {
            let result = fix(source);
            if source.starts_with("command ") || source.starts_with("env ") || source.starts_with("nohup ") {
                assert!(!result.command.ends_with(&format!("\n{source}")), "for {source:?}");
            } else {
                assert!(result.command.ends_with(&format!("\n{source}")), "for {source:?}");
            }
            assert_eq!(result.replacements, vec!["rev".to_string()], "for {source:?}");
        }
    }

    #[test]
    fn quoted_shell_words_are_unwrapped() {
        let cases = [
            ("bash cd /c/dev/x && echo ok", "cd C:/dev/x && echo ok", "bash"),
            ("sh cd /c/dev/x && echo ok", "cd C:/dev/x && echo ok", "sh"),
            ("bash grep -rn kimix src tests | head -40", "grep -rn kimix src tests | head -40", "bash"),
            ("'bash' cd /c/dev/x && echo ok", "cd C:/dev/x && echo ok", "bash"),
            ("\"bash\" cd /c/dev/x && echo ok", "cd C:/dev/x && echo ok", "bash"),
            ("\\bash cd /c/dev/x && echo ok", "cd C:/dev/x && echo ok", "bash"),
        ];
        for (source, expected_tail, expected_shell) in cases {
            let result = fix(source);
            assert_eq!(last_line(&result.command), expected_tail, "for {source:?}");
            assert!(
                result.shell_wrappers.iter().any(|w| w == expected_shell),
                "for {source:?}: wrappers={:?}",
                result.shell_wrappers
            );
        }
    }

    #[test]
    fn dash_c_inline_script_replaces_wrapper() {
        for (source, tail) in [
            ("bash -c 'rev'", "rev"),
            ("bash -lc 'rev'", "rev"),
            ("bash -cl 'rev'", "rev"),
            ("bash -l -c 'rev'", "rev"),
            ("sh -c 'rev'", "rev"),
            ("dash -c 'rev'", "rev"),
            ("bash -c 'rev' && echo done", "rev && echo done"),
            ("bash -c 'echo $HOME'", "echo $HOME"),
        ] {
            let result = fix(source);
            assert_eq!(last_line(&result.command), tail, "for {source:?}");
            assert!(result.shell_wrappers.iter().any(|w| w.ends_with("-c")), "for {source:?}");
        }
    }

    #[test]
    fn dash_c_fixes_inner_windows_path_and_fallback() {
        let result = fix(r"bash -c 'cd C:\x && rev'");
        assert_eq!(last_line(&result.command), r"cd C:/x && rev");
        assert_eq!(result.replacements, vec!["rev".to_string()]);
        assert_eq!(result.path_changes, vec![r"C:\x".to_string()]);
        assert_eq!(result.shell_wrappers, vec!["bash -c".to_string()]);
    }

    #[test]
    fn legitimate_shell_invocations_are_preserved() {
        for command in [
            "bash script.sh",
            "bash ./script.sh",
            "bash ../tools/run",
            "bash scripts/deploy.sh",
            "sh build.sh --release",
            "bash -c 'echo hi' arg1",
            "bash -e -c \"rev\"",
            "bash -s",
            "bash --",
            "bash",
            "echo bash",
            "bash -c",
        ] {
            assert_eq!(fix(command), BashFix::unchanged(command.to_string()), "for {command:?}");
        }
    }

    #[test]
    fn data_and_declarations_are_unchanged() {
        for command in [
            "echo rev",
            "printf '%s' rev",
            "name=rev",
            "tool=gtimeout",
            "array=(rev open pbcopy)",
            "printf > rev",
            "cat < pbpaste",
            "echo /usr/bin/rev",
            "./rev",
            "bin/rev",
            "$tool",
            "${tool}",
            "$(printf rev)",
            "echo `printf rev`",
            "echo rev # rev",
            "# rev\necho ok",
            "case value in rev) echo match;; esac",
            "alias rev='printf alias'",
            "function rev { printf custom; }",
            "rev() { printf custom; }",
            "declare -f rev",
            "type rev",
            "command -v rev",
            "which rev",
            "echo $'rev\\nopen'",
            "echo \"literal rev and open\"",
        ] {
            assert_eq!(fix(command), BashFix::unchanged(command.to_string()), "for {command:?}");
        }
    }

    #[test]
    fn heredoc_body_and_delimiter_are_unchanged() {
        let command = "cat <<'EOF'\nrev\ngtimeout 1 false\nopen file\nEOF";
        assert_eq!(fix(command), BashFix::unchanged(command.to_string()));
    }

    #[test]
    fn comment_ignored_but_following_line_rewritten() {
        let source = "echo ok # rev\nrev";
        let result = fix(source);
        assert!(result.command.ends_with(&format!("\n{source}")));
        assert_eq!(result.replacements, vec!["rev".to_string()]);
    }

    #[test]
    fn first_function_body_command_is_rewritten() {
        for source in [
            "work() { rev <<< abc; }; work",
            "function work { rev <<< abc; }; work",
            "function work() { rev <<< abc; }; work",
        ] {
            let result = fix(source);
            assert!(result.command.ends_with(&format!("\n{source}")));
            assert_eq!(result.replacements, vec!["rev".to_string()], "for {source:?}");
        }
    }

    #[test]
    fn conditional_and_arithmetic_words_are_not_commands() {
        for command in [
            "[[ rev == rev && rev == rev ]] && printf OK",
            "rev=1; (( rev )); printf '%s' $?",
            "let rev=1",
            "for ((rev=0; rev<2; rev++)); do printf x; done",
        ] {
            assert_eq!(fix(command), BashFix::unchanged(command.to_string()), "for {command:?}");
        }
    }

    #[test]
    fn command_after_case_is_detected() {
        let source = "case x in x) :;; esac; rev <<< abc";
        let result = fix(source);
        assert!(result.command.ends_with(&format!("\n{source}")));
        assert_eq!(result.replacements, vec!["rev".to_string()]);
    }

    #[test]
    fn windows_backslash_paths_rewritten() {
        let cases = [
            ("cd D:\\kimi-agent\\kimi-cli", "cd D:/kimi-agent/kimi-cli"),
            ("cd C:\\", "cd C:/"),
            ("cd \\\\server\\share\\dir", "cd //server/share/dir"),
            ("cd \\Users\\foo", "cd /Users/foo"),
            ("cd ~\\Desktop\\file.txt", "cd ~/Desktop/file.txt"),
            ("cd .\\build\\dist", "cd ./build/dist"),
            ("cd ..\\..\\repo", "cd ../../repo"),
            ("mkdir build\\dist\\assets", "mkdir build/dist/assets"),
            ("echo D:\\foo", "echo D:/foo"),
            ("cd D:\\a\\b && cp D:\\a\\b.txt E:\\dest\\", "cd D:/a/b && cp D:/a/b.txt E:/dest/"),
            ("env -C D:\\x cmd", "env -C D:/x cmd"),
            ("env --chdir D:\\x cmd", "env --chdir D:/x cmd"),
            ("env --chdir=D:\\x cmd", "env --chdir=D:/x cmd"),
            ("time -o D:\\out.txt cmd", "time -o D:/out.txt cmd"),
            ("sudo -D D:\\x cmd", "sudo -D D:/x cmd"),
        ];
        for (source, expected) in cases {
            let result = fix(source);
            assert_eq!(result.command, expected, "for {source:?}");
            assert!(result.changed(), "for {source:?}");
            assert!(result.replacements.is_empty(), "for {source:?}");
            assert!(!result.path_changes.is_empty(), "for {source:?}");
        }
    }

    #[test]
    fn path_with_spaces_is_quoted() {
        let result = fix(r"cd D:\Program\ Files\Git");
        assert_eq!(result.command, r#"cd "D:/Program Files/Git""#);
        assert_eq!(result.path_changes, vec![r"D:\Program\ Files\Git".to_string()]);
    }

    #[test]
    fn path_with_metacharacter_is_quoted() {
        let result = fix(r"cd D:\a\&b\c");
        assert_eq!(result.command, r#"cd "D:/a&b/c""#);
    }

    #[test]
    fn tilde_with_spaces_keeps_tilde_outside_quotes() {
        let result = fix(r"cd ~\My\ Docs\x");
        assert_eq!(result.command, r#"cd ~"/My Docs/x""#);
    }

    #[test]
    fn cd_d_flag_dropped() {
        let result = fix(r"cd /d D:\kimi-agent\kimi-cli");
        assert_eq!(result.command, "cd  D:/kimi-agent/kimi-cli");
        assert_eq!(result.path_changes, vec!["cd /d".to_string(), r"D:\kimi-agent\kimi-cli".to_string()]);
    }

    #[test]
    fn cd_flag_requires_following_argument() {
        for command in ["cd /d", "cd /d && echo x", "cd /d # comment"] {
            assert_eq!(fix(command), BashFix::unchanged(command.to_string()), "for {command:?}");
        }
    }

    #[test]
    fn cd_flag_dropped_with_quoted_path_preserved() {
        let result = fix(r"cd /d 'D:\x'");
        assert_eq!(result.command, r"cd  'D:\x'");
    }

    #[test]
    fn redirection_target_path_rewritten() {
        let result = fix(r"echo hi > D:\out.txt");
        assert_eq!(result.command, "echo hi > D:/out.txt");
    }

    #[test]
    fn path_after_environment_assignment_is_data() {
        assert_eq!(fix(r"env FOO=D:\x true"), BashFix::unchanged(r"env FOO=D:\x true".to_string()));
    }

    #[test]
    fn ambiguous_or_quoted_words_are_untouched() {
        for command in [
            r"echo foo\bar",
            r"echo a\nb",
            r"echo 'D:\foo'",
            r#"echo "D:\foo""#,
            r"printf '%s\n' a",
            r"echo $PATH\foo",
            r"x=D:\foo",
            r"case value in D:\x) echo hit;; esac",
            r"[[ -d D:\x ]]",
            r"echo \a\b",
            r"echo \n\t",
            r"printf \033\015",
            r"echo x\n\t",
            r"cd \a\b\c",
            r"env -C 'D:\x' cmd",
            r"time -o log.txt cmd",
            r"env -u D:\x cmd",
            r"env -C /d cmd",
        ] {
            assert_eq!(fix(command), BashFix::unchanged(command.to_string()), "for {command:?}");
        }
    }

    #[test]
    fn git_bash_posix_paths_rewritten() {
        let tmp = windows_temp_dir();
        let cases = [
            ("echo /tmp/x.txt", format!("echo {tmp}/x.txt")),
            ("cat > /tmp/out.txt", format!("cat > {tmp}/out.txt")),
            ("cd /tmp", format!("cd {tmp}")),
            ("echo /c/dev/file.cpp", "echo C:/dev/file.cpp".to_string()),
            ("echo /C/Dev/file.cpp", "echo C:/Dev/file.cpp".to_string()),
            ("cd /d/foo", "cd D:/foo".to_string()),
            ("/c/Windows/System32/where.exe cmd", "C:/Windows/System32/where.exe cmd".to_string()),
        ];
        for (source, expected) in cases {
            let result = fix(source);
            assert_eq!(result.command, expected, "for {source:?}");
            assert!(result.changed(), "for {source:?}");
            assert!(result.replacements.is_empty(), "for {source:?}");
            assert!(!result.path_changes.is_empty(), "for {source:?}");
        }
    }

    #[test]
    fn git_bash_posix_path_data_and_ambiguous_untouched() {
        for command in [
            "echo '/tmp/x'",
            "echo \"/tmp/x\"",
            "cat <<'EOF'\n/tmp/x\nEOF",
            "echo /tmpfile",
            "echo /d",
            "echo /c",
            "x=/tmp/x",
            "echo ok # cd /tmp/x",
        ] {
            assert_eq!(fix(command), BashFix::unchanged(command.to_string()), "for {command:?}");
        }
    }

    #[test]
    fn cd_d_flag_is_not_mistaken_for_drive_path() {
        let result = fix(r"cd /d D:\x && echo /d && cd /d/foo");
        assert_eq!(result.command, "cd  D:/x && echo /d && cd D:/foo");
        assert_eq!(result.path_changes, vec!["cd /d".to_string(), r"D:\x".to_string(), "/d/foo".to_string()]);
    }

    #[test]
    fn array_element_paths_rewritten() {
        let cases = [
            (r"arr=(D:\x\y.txt D:\a\b.txt)", "arr=(D:/x/y.txt D:/a/b.txt)"),
            (r"arr+=(D:\x\y.txt)", "arr+=(D:/x/y.txt)"),
            (r"arr=(C:\data\*.csv)", "arr=(C:/data/*.csv)"),
            (r"declare -a arr=(D:\x\y.txt)", "declare -a arr=(D:/x/y.txt)"),
            (r"local arr=(D:\x\y.txt)", "local arr=(D:/x/y.txt)"),
            (r"arr=(D:\Program\ Files\x.txt)", r#"arr=("D:/Program Files/x.txt")"#),
        ];
        for (source, expected) in cases {
            let result = fix(source);
            assert_eq!(result.command, expected, "for {source:?}");
            assert!(result.changed(), "for {source:?}");
            assert!(result.replacements.is_empty(), "for {source:?}");
        }
    }

    #[test]
    fn array_elements_stay_data() {
        for command in [
            r"arr=('D:\x\y.txt')",
            r#"arr=("D:\x\y.txt")"#,
            "array=(rev open pbcopy)",
            "declare -a x=(rev)",
            "declare -a x=(wget xclip xsel)",
            r"arr=([k]=D:\x)",
        ] {
            assert_eq!(fix(command), BashFix::unchanged(command.to_string()), "for {command:?}");
        }
    }

    #[test]
    fn substitution_inside_array_is_scanned() {
        let result = fix("arr=($(rev <<< abc))");
        assert_eq!(result.replacements, vec!["rev".to_string()]);
    }

    #[test]
    fn command_word_paths_rewritten() {
        let cases = [
            (r"C:\Windows\System32\where.exe git", "C:/Windows/System32/where.exe git"),
            (r"\\server\share\tool.exe arg", "//server/share/tool.exe arg"),
            (r".\build\tool.exe arg", "./build/tool.exe arg"),
            (r"..\scripts\run.sh", "../scripts/run.sh"),
            (r"~\bin\tool.exe --help", "~/bin/tool.exe --help"),
            (r"\Users\me\tool.exe", "/Users/me/tool.exe"),
            (r"build\dist\tool.exe arg", "build/dist/tool.exe arg"),
            (r"echo a && C:\x\tool.exe", "echo a && C:/x/tool.exe"),
            (r"command C:\x\tool.exe", "command C:/x/tool.exe"),
            (r"env FOO=1 D:\x\tool.exe", "env FOO=1 D:/x/tool.exe"),
            (r"nohup D:\x\tool.exe &", "nohup D:/x/tool.exe &"),
            (r"D:\x\*.exe", "D:/x/*.exe"),
            (r"x=$(C:\x\tool.exe)", "x=$(C:/x/tool.exe)"),
            (r"echo `C:\x\tool.exe`", "echo `C:/x/tool.exe`"),
        ];
        for (source, expected) in cases {
            let result = fix(source);
            assert_eq!(result.command, expected, "for {source:?}");
            assert!(result.changed(), "for {source:?}");
            assert!(result.replacements.is_empty(), "for {source:?}");
        }
    }

    #[test]
    fn command_word_non_paths_untouched() {
        for command in [
            "echo hello",
            "git --version",
            r"'C:\x\tool.exe' arg",
            r#"'"'"'C:\x\tool.exe'"'"' arg"#,
            r"foo\bar arg",
            r"\a\b",
            r"x\n\t",
        ] {
            assert_eq!(fix(command), BashFix::unchanged(command.to_string()), "for {command:?}");
        }
    }

    #[test]
    fn fallback_name_takes_priority_over_path_rewrite() {
        let result = fix(r"\rev <<< abc");
        assert_eq!(result.replacements, vec!["rev".to_string()]);
        assert!(result.path_changes.is_empty());
    }

    #[test]
    fn heredoc_trailing_operator_is_moved() {
        for (operator, rest, expected) in [
            ("&&", "echo next", " && echo next"),
            ("||", "echo fallback", " || echo fallback"),
            (";", "echo done", " ; echo done"),
            ("|", "tr a b", " | tr a b"),
            ("|&", "cat", " |& cat"),
        ] {
            let source = format!("cat <<EOF\nhello\nEOF\n{operator} {rest}");
            let result = fix(&source);
            assert_eq!(result.command, format!("cat <<EOF{expected}\nhello\nEOF\n"), "for {operator:?}");
        }
    }

    #[test]
    fn heredoc_operator_alone_on_line_is_moved() {
        let source = "python - <<'PY'\nprint(1)\nPY\n&&\necho next";
        let result = fix(source);
        assert_eq!(result.command, "python - <<'PY' && echo next\nprint(1)\nPY\n");
    }

    #[test]
    fn no_change_when_no_trailing_operator() {
        let source = "cat <<EOF\nhello\nEOF\necho next";
        assert_eq!(fix(source), BashFix::unchanged(source.to_string()));
    }

    #[test]
    fn no_change_when_delimiter_line_has_trailing_text() {
        let source = "cat <<EOF\nhello\nEOF extra\n&& echo next";
        assert_eq!(fix(source), BashFix::unchanged(source.to_string()));
    }

    #[test]
    fn windows_path_and_cd_flag_interaction() {
        let source = "cd /d D:\\compute && python - <<'PY'\nprint(1)\nPY\n&& git status --short src/ext/BTree";
        let result = fix(source);
        let expected = "cd  D:/compute && python - <<'PY' && git status --short src/ext/BTree\nprint(1)\nPY\n";
        assert_eq!(result.command, expected);
    }

    #[test]
    fn new_fallbacks_are_rewritten() {
        for source in [
            "copy a b",
            "move a b",
            "del a",
            "erase a",
            "ren a b",
            "rd d",
            "md d",
            "chdir .",
            "cls",
            "xcopy a b",
            "mklink /D link target",
            "findstr x file",
            "fc a b",
            "where bash",
            "tasklist",
            "taskkill /IM notepad /F",
            "systeminfo",
            "watch -n 1 true",
            "killall bash",
            "pidof bash",
            "column -t file",
        ] {
            let result = fix(source);
            assert!(result.changed(), "for {source:?}");
            assert!(result.command.ends_with(&format!("\n{source}")), "for {source:?}");
            let name = source.split(' ').next().unwrap();
            assert!(result.replacements.contains(&name.to_string()), "for {source:?}");
        }
    }

    #[test]
    fn new_fallback_data_and_declarations_unchanged() {
        for command in [
            "echo copy a b",
            "name=copy",
            "array=(del erase)",
            "printf > md",
            "cat < rd",
            "./copy",
            "$tool",
            "$(printf copy)",
            "echo `printf del`",
            "echo copy # copy a b",
            "case value in copy) echo match;; esac",
            "alias copy='printf alias'",
            "function copy { printf custom; }",
            "declare -f copy",
            "type copy",
            "command -v copy",
            "which copy",
            "echo tasklist",
            "echo watch date",
        ] {
            assert_eq!(fix(command), BashFix::unchanged(command.to_string()), "for {command:?}");
        }
    }

    #[test]
    fn arbitrary_malformed_input_never_crashes() {
        for command in [
            "'",
            "\"",
            "`",
            "$(",
            "${",
            "((",
            "cat <<EOF\nunterminated",
            "echo \\",
            "rev '",
            "rev \"",
            "echo $(rev",
            "echo `rev",
            "if rev; then",
            "case x in rev)",
        ] {
            let result = fix(command);
            assert!(!result.command.is_empty() || result.command.is_empty(), "for {command:?}");
        }
    }

    #[test]
    fn many_commands_are_all_rewritten_linearly() {
        let source = vec!["rev"; 2_000].join("; ");
        let result = fix(&source);
        assert!(result.command.ends_with(&format!("\n{source}")));
        assert_eq!(result.replacements.len(), 2_000);
    }

    // ---- _process_unquoted ------------------------------------------------

    #[test]
    fn unquoted_converts_backslashes() {
        assert_eq!(
            process_unquoted(r"cat src\kimix\tools\file\bash\bash_tool.py"),
            "cat src/kimix/tools/file/bash/bash_tool.py"
        );
        assert_eq!(process_unquoted(r"cat C:\Users\test\file.txt"), "cat C:/Users/test/file.txt");
        assert_eq!(process_unquoted(r"cd .\subdir"), "cd ./subdir");
        assert_eq!(process_unquoted(r"diff a\b\c.py x\y\z.py"), "diff a/b/c.py x/y/z.py");
    }

    #[test]
    fn unquoted_preserves_quoted_backslashes() {
        assert_eq!(process_unquoted(r"echo 'hello\world'"), r"echo 'hello\world'");
        assert_eq!(process_unquoted(r#"echo "hello\world""#), r#"echo "hello\world""#);
        assert_eq!(process_unquoted(r"echo $'hello\nworld'"), r"echo $'hello\nworld'");
        assert_eq!(process_unquoted(r#"cat 'src\a.py' src\b.py"#), r"cat 'src\a.py' src/b.py");
        assert_eq!(process_unquoted(r#"echo "hello \"world\"""#), r#"echo "hello \"world\"""#);
    }

    #[test]
    fn unquoted_preserves_backslash_metachars() {
        assert_eq!(process_unquoted(r"echo a\|b"), r"echo a\|b");
        assert_eq!(process_unquoted(r"echo a\;b"), r"echo a\;b");
        assert_eq!(process_unquoted(r"echo a\&b"), r"echo a\&b");
        assert_eq!(process_unquoted(r"echo \*"), r"echo \*");
        assert_eq!(process_unquoted(r"echo \$HOME"), r"echo \$HOME");
        assert_eq!(process_unquoted(r"echo \`cmd\`"), r"echo \`cmd\`");
        assert_eq!(process_unquoted(r"echo \{a,b\}"), r"echo \{a,b\}");
        assert_eq!(process_unquoted(r"echo hello\ world"), r"echo hello\ world");
        assert_eq!(process_unquoted(r"echo \\path"), "echo //path");
        assert_eq!(process_unquoted("echo trailing\\"), "echo trailing/");
    }

    #[test]
    fn unquoted_descends_into_substitutions() {
        assert_eq!(process_unquoted(r"echo $(cat src\file.py)"), "echo $(cat src/file.py)");
        assert_eq!(process_unquoted(r"echo `cat src\file.py`"), "echo `cat src/file.py`");
        assert_eq!(process_unquoted(r#"echo "$(cat src\foo\bar)""#), r#"echo "$(cat src/foo/bar)""#);
        assert_eq!(process_unquoted(r#"echo "$(cat $(echo src\foo\bar))""#), r#"echo "$(cat $(echo src/foo/bar))""#);
        assert_eq!(process_unquoted(r"cat \\server\share\file.txt"), "cat //server/share/file.txt");
    }

    #[test]
    fn unquoted_handles_unterminated_regions() {
        assert_eq!(process_unquoted(r"echo 'hello src\file.py"), r"echo 'hello src\file.py");
        assert_eq!(process_unquoted(r#"echo "hello src\file.py"#), r#"echo "hello src\file.py"#);
        assert_eq!(process_unquoted(r#"echo "$(unterminated"#), r#"echo "$(unterminated"#);
        assert_eq!(process_unquoted(r#"echo "`no close"#), r#"echo "`no close"#);
    }

    #[test]
    fn bash_compatibility_prelude_contains_exports() {
        let prelude = bash_compatibility_prelude();
        if cfg!(target_os = "windows") {
            assert!(prelude.contains("rev()"));
            assert!(prelude.contains("export -f rev"));
            assert!(prelude.contains("wget"));
        } else {
            assert_eq!(prelude, "");
        }
    }
}
