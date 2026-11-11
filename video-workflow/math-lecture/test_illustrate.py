from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from illustrate import anchors, load_illustration, mark_images, move_parameter_labels, render_unit
from pipeline import digest, save, validate_unit_body


class IllustrationTests(unittest.TestCase):
    def test_parameter_expressions_become_latex_beside_plot(self):
        data = [{"plot": {"scene": {"elements": [{"label": "−a"}, {"text": "√(a+1)"}, {"label": "−3"}]}}}]
        result = move_parameter_labels(data)[0]
        self.assertEqual(result["plot"]["scene"]["elements"], [{"label": "①"}, {"text": "②"}, {"label": "−3"}])
        self.assertIn("$-a$", result["label_note"])
        self.assertIn(r"$\sqrt{a+1}$", result["label_note"])

    def test_text_pass_requires_each_source_marker_without_embeds(self):
        payload = {"diagram_slots": [{"id": "img0001"}]}
        body = "- 曲线穿过横轴。\n\n  <!-- lecture-figure:img0001 -->\n"
        validate_unit_body(body, payload)
        with self.assertRaisesRegex(ValueError, "markers_must_match"):
            validate_unit_body(body + "  <!-- lecture-figure:img0001 -->\n", payload)
        with self.assertRaisesRegex(ValueError, "diagram_rendering_is_deferred"):
            validate_unit_body(body + "  ```mermaid\n  flowchart TD\n  ```\n", payload)

    def test_original_image_and_new_mermaid_keep_text_and_math(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            plot = root / "original.png"
            plot.write_bytes(b"approved synthetic diagram")
            asset = {"id": "reconstructed-img0001", "link": "images/original.png", "path": str(plot),
                     "sha256": digest(plot.read_bytes()), "source_image_id": "img0001", "receipt_sha256": "fixture"}
            original = "- 横轴交点。\n\n  ![零点](images/original.png)\n\n  $$\n  x^2=1\n  $$\n\n  - 分类讨论。\n"
            draft, slots = mark_images(original, {"allowed_images": [asset]})
            self.assertNotIn("images/original.png", draft)
            self.assertNotIn(6, anchors(draft))
            item = {"unit": {"id": "u001"}, "key": "fixture", "draft": draft, "slots": slots, "work": root}
            decisions = [{"after_line": 9, "alt": "判断零点", "mermaid": {"direction": "TD",
                "nodes": [{"id": "A", "text": "比较零点"}, {"id": "B", "text": "确定区间"}],
                "edges": [{"from": "A", "to": "B"}]}}]
            result = render_unit(item, decisions)
            self.assertEqual(result["counts"], {"source_reuse": 1, "new_mermaid": 1})
            self.assertIn("x^2=1", result["body"])
            self.assertNotIn("lecture-figure", result["body"])
            self.assertIn("```mermaid", result["body"])
            save(root / "illustrated.json", {**result, "key": item["key"], "plan": decisions,
                "body_sha256": digest(result["body"].encode())})
            self.assertEqual(load_illustration(item)["body"], result["body"])
            decisions[0]["after_line"] = 6
            with self.assertRaisesRegex(ValueError, "diagram_anchor_invalid"):
                render_unit(item, decisions)
