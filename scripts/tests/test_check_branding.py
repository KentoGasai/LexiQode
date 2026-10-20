#!/usr/bin/env python3
"""Tests for the branding rules.

    python scripts/tests/test_check_branding.py

No toolchain, no network, no build: the rules are pure functions over a
manifest, so they can be exercised on any machine. That matters because the
machine that cannot compile is exactly the machine that needs to trust them.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check_branding as cb  # noqa: E402


def manifest(**overrides: object) -> dict:
    """A minimally correct branded manifest, with the given fields replaced."""

    base: dict = {
        "nameShort": "LexiQode",
        "nameLong": "LexiQode",
        "applicationName": "lexiqode",
        "dataFolderName": ".lexiqode",
        "urlProtocol": "lexiqode",
        "win32MutexName": "lexiqode",
        "win32AppUserModelId": "LexiQode.LexiQode",
        "win32RegValueName": "LexiQode",
        "enableTelemetry": False,
        "voiceWsUrl": "",
        "webviewContentExternalBaseUrlTemplate": "",
        "extensionsGallery": {"serviceUrl": "https://open-vsx.org/vscode/gallery"},
    }
    base.update(overrides)
    return base


class VendorUrlTest(unittest.TestCase):
    def setUp(self) -> None:
        self.hosts = cb.vendor_hosts()

    def test_the_shared_list_is_not_empty(self) -> None:
        self.assertIn("aka.ms", self.hosts)
        self.assertIn("api.github.com", self.hosts)

    def test_vendor_endpoints_are_recognised(self) -> None:
        for url in (
            "https://aka.ms/github-copilot-overview",
            "https://api.github.com/copilot_internal/user",
            "https://login.microsoft.com/tenant",
            "http://sub.visualstudio.com/x",
        ):
            with self.subTest(url=url):
                self.assertTrue(cb.vendor_url(url, self.hosts))

    def test_our_own_urls_are_left_alone(self) -> None:
        for url in (
            "https://open-vsx.org/vscode/gallery",
            # A licence link to the sources is a reference, not a service.
            "https://github.com/microsoft/vscode/blob/main/LICENSE.txt",
            "https://raw.githubusercontent.com/EclipseFdn/publish-extensions/master/x.json",
            # A different registrable domain must not match a listed one.
            "https://xazure.com/",
            "",
            "not a url",
        ):
            with self.subTest(url=url):
                self.assertFalse(cb.vendor_url(url, self.hosts))


class TransformTest(unittest.TestCase):
    def setUp(self) -> None:
        self.hosts = cb.vendor_hosts()

    def test_nested_urls_are_emptied_and_others_kept(self) -> None:
        document = {
            "kept": "https://open-vsx.org/vscode/gallery",
            "agent": {
                "signUpUrl": "https://aka.ms/github-sign-up",
                "entitlementUrl": "https://api.github.com/copilot_internal/user",
                "provider": {"default": {"id": "github", "name": "GitHub"}},
                "scopes": [["read:user"], ["user:email"]],
            },
            "list": ["https://aka.ms/a", "https://open-vsx.org/b"],
        }
        emptied = cb.blank_vendor_urls(document, self.hosts)

        # Two, not three: the third match sits inside an array, and arrays are not
        # mutated - see the rule asserted below.
        self.assertEqual(emptied, 2)
        self.assertEqual(document["agent"]["signUpUrl"], "")
        self.assertEqual(document["agent"]["entitlementUrl"], "")
        self.assertEqual(document["list"][0], "https://aka.ms/a")
        self.assertEqual(document["list"][1], "https://open-vsx.org/b")
        self.assertEqual(document["kept"], "https://open-vsx.org/vscode/gallery")
        # Non-URL values must survive untouched, including nested ones.
        self.assertEqual(document["agent"]["provider"]["default"]["name"], "GitHub")
        self.assertEqual(document["agent"]["scopes"], [["read:user"], ["user:email"]])

    def test_a_vendor_url_inside_an_array_is_reported_rather_than_mangled(self) -> None:
        document = manifest(links=["https://aka.ms/a", "https://open-vsx.org/b"])
        cb.blank_vendor_urls(document, self.hosts)

        # Untouched, so the list keeps its length and meaning...
        self.assertEqual(document["links"][0], "https://aka.ms/a")
        # ...and the release check refuses the build instead of letting it through.
        problems = cb.check(document, "test", self.hosts)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("links[0]", problems[0])

    def test_a_manifest_with_nothing_to_empty_reports_zero(self) -> None:
        document = {"kept": "https://open-vsx.org/vscode/gallery"}
        self.assertEqual(cb.blank_vendor_urls(document, self.hosts), 0)


class MergeTest(unittest.TestCase):
    def test_underscore_keys_are_documentation_not_product_data(self) -> None:
        upstream = {"nameShort": "Code", "keep": 1}
        overlay = {"_comment": ["why"], "nameShort": "LexiQode"}
        merged, changed, added = cb.merge(upstream, overlay)

        self.assertEqual(merged["nameShort"], "LexiQode")
        self.assertNotIn("_comment", merged)
        self.assertEqual(changed, ["nameShort"])
        self.assertEqual(added, [])
        self.assertEqual(merged["keep"], 1)

    def test_a_key_upstream_lacks_is_added(self) -> None:
        merged, changed, added = cb.merge({"a": 1}, {"b": 2})
        self.assertEqual(merged, {"a": 1, "b": 2})
        self.assertEqual(changed, [])
        self.assertEqual(added, ["b"])

    def test_the_merge_does_not_mutate_the_input(self) -> None:
        upstream = {"nameShort": "Code"}
        cb.merge(upstream, {"nameShort": "LexiQode"})
        self.assertEqual(upstream["nameShort"], "Code")


class CheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.hosts = cb.vendor_hosts()

    def test_a_correct_manifest_passes(self) -> None:
        self.assertEqual(cb.check(manifest(), "test", self.hosts), [])

    def test_each_rule_can_fail(self) -> None:
        cases = {
            "identity": {"nameLong": "VSCodium"},
            "telemetry": {"enableTelemetry": True},
            "gallery": {"extensionsGallery": {"serviceUrl": "https://marketplace.example/x"}},
            "voice": {"voiceWsUrl": "wss://speech.microsoft.com/x"},
            "leftover url": {"agent": {"signUpUrl": "https://aka.ms/github-sign-up"}},
        }
        for label, override in cases.items():
            with self.subTest(rule=label):
                problems = cb.check(manifest(**override), "test", self.hosts)
                self.assertTrue(problems, f"the {label} rule did not fire")

    def test_the_download_feeds_are_exempt(self) -> None:
        # They are build inputs, carried by upstream, and never contacted by the
        # installed product.
        product = manifest(nodejsArtifactFeed="https://aka.ms/node-feed")
        self.assertEqual(cb.check(product, "test", self.hosts), [])


class LeftoversTest(unittest.TestCase):
    def test_vendor_ids_are_reported_but_not_fatal(self) -> None:
        product = manifest(defaultChatAgent={"extensionId": "GitHub.copilot"})
        found = cb.known_leftovers(product)
        self.assertEqual(len(found), 1)
        self.assertIn("GitHub.copilot", found[0])
        # Reporting must not turn into a failure: the manifest is otherwise correct.
        self.assertEqual(cb.check(product, "test", cb.vendor_hosts()), [])

    def test_a_bundled_vendor_extension_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / "resources" / "app"
            (app / "extensions" / "copilot").mkdir(parents=True)
            product_path = app / "product.json"
            product_path.write_text(json.dumps(manifest()), encoding="utf-8")
            found = cb.known_leftovers(manifest(), product_path)
            self.assertTrue(any("copilot" in line for line in found))


class BuiltTreeTest(unittest.TestCase):
    def test_a_missing_agent_or_core_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / "resources" / "app"
            app.mkdir(parents=True)
            product_path = app / "product.json"
            product_path.write_text(json.dumps(manifest()), encoding="utf-8")

            problems = cb.check_built_tree(product_path)
            self.assertEqual(len(problems), 2, problems)

            (app / "extensions" / "lexiqode" / "out").mkdir(parents=True)
            (app / "extensions" / "lexiqode" / "out" / "extension.js").write_text("", encoding="utf-8")
            core = app.parent / "lexiqode-core" / "lexiqode" / "server"
            core.mkdir(parents=True)
            (core / "http.py").write_text("", encoding="utf-8")

            self.assertEqual(cb.check_built_tree(product_path), [])


class RealManifestTest(unittest.TestCase):
    """The overlay must produce a correct build for the tag we actually ship."""

    def test_the_real_overlay_yields_a_correct_manifest(self) -> None:
        overlay = cb.read_json(cb.OVERLAY)
        upstream = cb.read_json(Path(__file__).resolve().parent.parent.parent / "ide" / "upstream-product.json")
        merged, _, _ = cb.merge(upstream, overlay)
        cb.blank_vendor_urls(merged, cb.vendor_hosts())
        self.assertEqual(cb.check(merged, "overlay result", cb.vendor_hosts()), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)