"""Read-only rendering acceptance in isolated headless Chrome; never uses a user profile."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-gpu"])
    page = browser.new_page(viewport={"width": 1280, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:37829/imports", wait_until="networkidle")
    page.wait_for_selector(".source")
    assert page.title() == "导入管理 · 渐进阅读"
    results = []
    for form in [False, True]:
        # Display the form only; no clicks, requests, settings changes or submissions.
        page.evaluate("value => document.getElementById('site-editor').hidden = !value", form)
        for width in [1280, 768, 414, 375, 320]:
            page.set_viewport_size({"width": width, "height": 1000})
            data = page.evaluate("""() => ({root:document.documentElement.scrollWidth,viewport:innerWidth,
              smallButtons:[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&e.getBoundingClientRect().height<43).length})""")
            assert data["root"] <= width, (width, form, data)
            assert not data["smallButtons"], (width, form, data)
            page.screenshot(path=str(output / f"imports-{'form' if form else 'list'}-{width}.png"), full_page=True)
            results.append({"width": width, "form": form, **data})
    assert not errors, errors
    browser.close()
    report = {"status": "passed", "checks": results, "console_errors": errors, "mutations": 0}
    (output / "render-check.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
