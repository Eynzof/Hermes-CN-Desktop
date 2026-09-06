"""Launch-mode selection tests for run.py.

Locks in the safe launch-mode policy:

- The managed runtime remains the default.
- ``--embedded`` opts into the merged real package: HERMES_DESKTOP_EMBEDDED_PAYLOAD
  override or ``<core>/hermes_embedded``. The desktop repo carries no embedded
  package of its own, so a Core checkout without ``hermes_embedded`` (or a
  missing Core checkout) is a hard error — never a silent demo fallback.
- The embedded launch sets VITE_HERMES_SKIP_VERSION_CHECK=1 because the
  embedded package reports the real Core version via FFI, which can differ
  from the desktop bundle's baked EXPECTED_BACKEND_VERSION.
- ``--real-backend`` remains a deprecated alias for the default managed path.

Run: python -m unittest discover -s tests/python -v
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

DESKTOP_ROOT = Path(__file__).resolve().parents[2]
RUN_PY = DESKTOP_ROOT / "run.py"


def _load_run_module():
    spec = importlib.util.spec_from_file_location("hermes_run_py", RUN_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _make_core_root(tmp: str, with_payload: bool) -> Path:
    # macOS exposes /var through /private/var. Match run.py's resolved paths so
    # assertions describe identity rather than the spelling of the symlink.
    core_root = Path(tmp).resolve()
    (core_root / "pyproject.toml").write_text("[project]\nname='x'\n", encoding="utf-8")
    if with_payload:
        pkg = core_root / "hermes_embedded"
        pkg.mkdir(parents=True)
        (pkg / "api.py").write_text("# api\n", encoding="utf-8")
    return core_root


class _FakeProc:
    """Minimal Popen stand-in: never exits."""

    def __init__(self):
        self.env = None
        self.args = None

    def poll(self):  # pragma: no cover - loop keeps polling until interrupt
        return None

    def terminate(self):  # pragma: no cover
        pass

    def kill(self):  # pragma: no cover
        pass

    def wait(self, timeout=None):  # pragma: no cover
        return None


class LaunchModeTests(unittest.TestCase):
    def setUp(self):
        self.run_mod = _load_run_module()
        self._saved_env = {
            k: os.environ.get(k)
            for k in (
                "HERMES_CN_CORE",
                "HERMES_DESKTOP_EMBEDDED_PYTHON",
                "HERMES_DESKTOP_EMBEDDED_PAYLOAD",
                "HERMES_AGENT_CN_SOURCE",
                "HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL",
                "VITE_HERMES_SKIP_VERSION_CHECK",
            )
        }
        for key in self._saved_env:
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _launch(self, argv, core_root):
        """Run run.main() under stubs; return (env_of_spawned_proc, spawned)."""
        proc = _FakeProc()
        captured = {}

        def fake_popen(args, **kwargs):
            proc.args = args
            proc.env = kwargs.get("env")
            captured["env"] = dict(proc.env or {})
            return proc

        def fake_sleep(_seconds):
            raise KeyboardInterrupt  # break main()'s wait loop immediately

        with mock.patch.object(self.run_mod, "Popen", side_effect=fake_popen), \
             mock.patch.object(self.run_mod.time, "sleep", side_effect=fake_sleep), \
             mock.patch.object(sys, "argv", ["run.py", *argv]), \
             mock.patch.dict(os.environ, {"HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL": "1"}):
            self.assertRaises(KeyboardInterrupt, self.run_mod.main)
        return captured.get("env"), proc

    def test_backend_with_own_hermes_embedded_embeds_that_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            core_root = _make_core_root(tmp, with_payload=True)
            env, proc = self._launch(
                ["--skip-prereqs", "--backend", str(core_root), "--embedded"],
                core_root,
            )

        self.assertIsNotNone(env)
        self.assertEqual(env["HERMES_DESKTOP_EMBEDDED_PYTHON"], "1")
        self.assertEqual(Path(env["HERMES_DESKTOP_EMBEDDED_PAYLOAD"]), core_root / "hermes_embedded")
        self.assertEqual(Path(env["HERMES_AGENT_CN_SOURCE"]), core_root)
        self.assertIn("tauri:dev", proc.args)

    def test_embedded_launch_skips_the_baked_version_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            core_root = _make_core_root(tmp, with_payload=True)
            env, _ = self._launch(
                ["--skip-prereqs", "--source", str(core_root), "--embedded"],
                core_root,
            )

        self.assertEqual(env["VITE_HERMES_SKIP_VERSION_CHECK"], "1")

    def test_embedded_backend_without_payload_is_a_hard_error(self):
        # No reference/demo fallback exists anymore: a Core checkout without
        # the merged package must fail loudly instead of embedding a stub.
        with tempfile.TemporaryDirectory() as tmp:
            core_root = _make_core_root(tmp, with_payload=False)
            with mock.patch.object(
                sys,
                "argv",
                ["run.py", "--skip-prereqs", "--backend", str(core_root), "--embedded"],
            ):
                self.assertRaises(SystemExit, self.run_mod.main)

    def test_default_launch_uses_managed_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            core_root = _make_core_root(tmp, with_payload=True)
            env, proc = self._launch(
                ["--skip-prereqs", "--backend", str(core_root)], core_root
            )

        self.assertEqual(env["HERMES_DESKTOP_EMBEDDED_PYTHON"], "0")
        self.assertNotIn("HERMES_DESKTOP_EMBEDDED_PAYLOAD", env)
        self.assertEqual(Path(env["HERMES_AGENT_CN_SOURCE"]), core_root)
        self.assertIn("tauri:dev", proc.args)

    def test_real_backend_flag_keeps_managed_subprocess_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            core_root = _make_core_root(tmp, with_payload=False)
            env, _ = self._launch(
                ["--skip-prereqs", "--backend", str(core_root), "--real-backend"], core_root
            )

        self.assertEqual(env["HERMES_DESKTOP_EMBEDDED_PYTHON"], "0")
        self.assertNotIn("HERMES_DESKTOP_EMBEDDED_PAYLOAD", env)
        self.assertEqual(Path(env["HERMES_AGENT_CN_SOURCE"]), core_root)

    def test_missing_override_payload_is_a_hard_error_in_embedded_mode(self):
        proc_holder = {}

        def fake_popen(args, **kwargs):
            proc_holder["proc"] = _FakeProc()
            return proc_holder["proc"]

        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(self.run_mod, "Popen", side_effect=fake_popen), \
             mock.patch.dict(os.environ, {
                 "HERMES_DESKTOP_EMBEDDED_PAYLOAD": str(tmp),
                 "HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL": "1",
             }):
            with mock.patch.object(
                sys, "argv", ["run.py", "--skip-prereqs", "--embedded"]
            ):
                with self.assertRaises(SystemExit):
                    self.run_mod.main()
        self.assertNotIn("proc", proc_holder)

    def test_bare_run_without_any_core_checkout_is_a_hard_error(self):
        with mock.patch.object(self.run_mod, "_resolve_core_source", return_value=None), \
             mock.patch.object(sys, "argv", ["run.py", "--skip-prereqs"]):
            self.assertRaises(SystemExit, self.run_mod.main)

    def test_explicit_missing_core_does_not_fall_back_to_sibling(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp).resolve() / "missing-core"
            self.assertIsNone(self.run_mod._resolve_core_source(str(missing)))
            self.assertEqual(
                self.run_mod.resolve_embedded_payload(str(missing), None),
                (None, ""),
            )

    def test_conflicting_mode_flags_are_rejected(self):
        with mock.patch.object(
            sys, "argv", ["run.py", "--embedded", "--real-backend"]
        ):
            with self.assertRaises(SystemExit):
                self.run_mod.main()


if __name__ == "__main__":
    unittest.main()
