"""No transcription, model downloads or user files: verify process launch only."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("whisper_runner", Path(__file__).with_name("local-whispercpp-transcribe.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class SilentChildTests(unittest.TestCase):
    def test_no_window_flag_and_output_capture(self):
        result = subprocess.CompletedProcess(["fixture"], 0, "ok", "")
        with patch.object(runner.subprocess, "run", return_value=result) as launch:
            self.assertIs(runner.run(["fixture"]), result)
        options = launch.call_args.kwargs
        self.assertTrue(options["capture_output"])
        self.assertEqual(options["creationflags"], subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)

    def test_real_child_output_still_works(self):
        result = runner.run([sys.executable, "-c", "print('silent-child-ok')"])
        self.assertEqual(result.stdout.strip(), "silent-child-ok")

    def test_failure_still_reported(self):
        with self.assertRaisesRegex(RuntimeError, "fixture-failure"):
            runner.run([sys.executable, "-c", "import sys; sys.stderr.write('fixture-failure'); sys.exit(3)"])


if __name__ == "__main__":
    unittest.main()
