"""Read-only rendering checks; uses an isolated headless browser, never a user profile."""
import json
import sys
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 1000}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:37829/subscriptions", wait_until="networkidle")
    page.wait_for_selector(".source")
    assert page.title() == "订阅管理 · 渐进阅读"
    results = []
    for width in [1280, 768, 414, 375, 320]:
        page.set_viewport_size({"width": width, "height": 1000})
        page.wait_for_timeout(100)
        dimensions = page.evaluate("""() => ({root:document.documentElement.scrollWidth, viewport:innerWidth,
          sources:document.querySelectorAll('.source').length,
          smallButtons:[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&e.getBoundingClientRect().height<43).length})""")
        assert dimensions["root"] <= width, (width, dimensions)
        assert dimensions["smallButtons"] == 0
        page.screenshot(path=str(output / f"subscriptions-{width}.png"), full_page=True)
        results.append({"width": width, **dimensions})
    # Render the existing form without submitting or changing application state.
    page.evaluate("document.getElementById('editor').hidden=false")
    for width in [768, 375, 320]:
        page.set_viewport_size({"width": width, "height": 1000})
        assert page.evaluate("document.documentElement.scrollWidth<=innerWidth")
        page.screenshot(path=str(output / f"form-{width}.png"), full_page=True)
    if "--repository" in sys.argv:
        captured_repository = []

        def capture_repository(route):
            captured_repository.append(route.request.post_data_json["source"])
            route.fulfill(json={"status": "saved"})

        page.route("**/api/subscriptions/source", capture_repository)
        page.locator("#add").click()
        page.locator("#kind").select_option("github_repository")
        page.locator("#name").fill("Repository fixture")
        page.locator("#url").fill("https://github.com/example/translations")
        page.locator("#repository-root").fill("docs")
        page.locator("#repository-site").fill("https://example.github.io/translations/")
        assert page.locator("#mode").input_value() == "original_text"
        assert page.locator("#history_mode").input_value() == "all"
        for width in [768, 414, 375, 320]:
            page.set_viewport_size({"width": width, "height": 1000})
            assert page.evaluate("document.documentElement.scrollWidth<=innerWidth")
            page.screenshot(path=str(output / f"repository-{width}.png"), full_page=True)
        page.locator("#save").click()
        expect(page.locator("#message")).to_contain_text("已保存")
        assert captured_repository[-1]["repository"]["content_root"] == "docs"
        assert captured_repository[-1]["repository"]["public_base"] == "https://example.github.io/translations/"
        assert captured_repository[-1]["mode"] == "original_text"
        page.unroute("**/api/subscriptions/source", capture_repository)
        print(json.dumps({"repository_form": "passed", "real_writes": 0}))
    if "--feedback" in sys.argv:
        state = page.request.get("http://127.0.0.1:37829/api/subscriptions").json()
        state["jobs"] = []
        submissions = []

        def mock_run(route):
            kind = route.request.post_data_json["kind"]
            submissions.append(kind)
            if kind == "zhihu":
                route.fulfill(status=400, json={"error": "fixture: 检查未受理"})
                return
            job = {"id": kind, "kind": kind, "status": "queued", "created_at": "2026-11-06T03:00:00Z"}
            state["jobs"].insert(0, job)
            route.fulfill(status=202, json=job)

        def mock_state(route):
            route.fulfill(json=state)
            for job in state["jobs"]:
                job["status"] = {"queued": "running", "running": "completed"}.get(job["status"], job["status"])

        page.add_init_script("Object.defineProperty(AbortSignal, 'timeout', {value: undefined})")
        page.route("**/api/subscriptions", mock_state)
        page.route("**/api/subscriptions/run", mock_run)
        page.goto("http://127.0.0.1:37829/subscriptions")
        page.wait_for_selector(".source")
        for kind in ("rss", "bilibili", "retry"):
            status = "#retry-run-status" if kind == "retry" else "#source-run-status"
            page.locator(f'[data-run="{kind}"]').click()
            expect(page.locator(status)).to_contain_text("完成", timeout=10000)
        page.locator('[data-run="zhihu"]').click()
        expect(page.locator("#source-run-status")).to_contain_text("检查未受理")
        assert submissions == ["rss", "bilibili", "retry", "zhihu"]
        page.get_by_role("button", name="编辑", exact=True).first.click()
        page.locator("#history_mode").select_option("since")
        assert page.locator("#earliest_date").is_visible()
        assert page.locator("#earliest_date").get_attribute("required") is not None
        page.locator("#history_mode").select_option("all")
        assert not page.locator("#earliest_date").is_visible()
        page.screenshot(path=str(output / "feedback-320.png"), full_page=True)
        print(json.dumps({"feedback": "passed", "submissions": submissions}, ensure_ascii=False))
    if "--settings" in sys.argv:
        state = page.request.get("http://127.0.0.1:37829/api/subscriptions").json()
        captured = []

        def capture_settings(route):
            captured.append(route.request.post_data_json["source"])
            route.fulfill(json={"status": "saved"})

        page.route("**/api/subscriptions", lambda route: route.fulfill(json=state))
        page.route("**/api/subscriptions/source", capture_settings)
        page.goto("http://127.0.0.1:37829/subscriptions", wait_until="networkidle")
        source = next(source for source in state["subscriptions"] if source["kind"] == "rss" and source["mode"] == "reports")
        row = page.locator(".source").filter(has=page.get_by_role("heading", name=source["name"], exact=True))
        row.get_by_role("button", name="编辑", exact=True).click()
        page.locator("#direct_reading").select_option("false")
        page.locator("#translation_mode").select_option("plain")
        page.locator("#generate_guide").select_option("true")
        page.get_by_role("button", name="保存订阅", exact=True).click()
        expect(page.locator("#message")).to_contain_text("已保存")
        assert captured[-1]["direct_reading"] is False
        assert captured[-1]["translation_mode"] == "plain"
        assert captured[-1]["generate_guide"] is True
        page.get_by_role("button", name="添加订阅", exact=True).click()
        expect(page.locator("#direct_reading")).to_have_value("true")
        expect(page.locator("#translation_mode")).to_have_value("terminology")
        expect(page.locator("#generate_guide")).to_have_value("false")
        for width in [320, 375, 414, 768]:
            page.set_viewport_size({"width": width, "height": 1000})
            assert page.evaluate("document.documentElement.scrollWidth<=innerWidth")
            page.screenshot(path=str(output / f"settings-{width}.png"), full_page=True)
        print(json.dumps({"settings": "passed", "live_writes": 0}, ensure_ascii=False))
    assert not errors, errors
    browser.close()
    (output / "render-check.json").write_text(json.dumps({"status": "passed", "widths": results, "console_errors": errors}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": "passed", "widths": results}, ensure_ascii=False))
