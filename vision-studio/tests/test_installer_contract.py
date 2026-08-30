from pathlib import Path
import unittest


class InstallerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (
            Path(__file__).resolve().parents[2]
            / "installer"
            / "Install-Krea2VisionSuite.ps1"
        ).read_text(encoding="utf-8")

    def test_discord_update_requires_current_betterdiscord_injection(self):
        self.assertIn("function Test-BetterDiscordInjected", self.source)
        self.assertIn("discord_desktop_core-*", self.source)
        self.assertIn("BetterDiscord's Injection Script", self.source)
        self.assertIn("if ((Test-BetterDiscordInjected) -and $Mode -ne 'Repair')", self.source)
        self.assertIn("if (-not (Test-BetterDiscordInjected))", self.source)
        self.assertIn("the current Discord app version was not injected", self.source)

    def test_winget_cli_fallback_and_process_races_are_handled(self):
        self.assertIn("Microsoft\\WinGet\\Packages", self.source)
        self.assertIn("betterdiscord.cli_*", self.source)
        self.assertIn("Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue", self.source)

    def test_model_downloads_and_runtime_share_suite_models_folder(self):
        self.assertIn("$modelRoot=Join-Path $installRoot 'models'", self.source)
        self.assertIn("'LLAMA_CPP_MODEL_ROOT' $modelRoot", self.source)
        self.assertIn("'-CacheRoot',(Join-Path $modelRoot '.downloads')", self.source)
        self.assertIn("'-ModelRoot',$modelRoot", self.source)


if __name__ == "__main__":
    unittest.main()
