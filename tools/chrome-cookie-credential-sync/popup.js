const syncButton = document.getElementById("sync");
const statusElement = document.getElementById("status");

function safeFailureText(code) {
  if (code === "chrome_cookie_read_failed") return "同步失败：无法读取 Chrome Cookie。";
  if (code === "local_service_unavailable") return "同步失败：本地渐进阅读服务不可用。";
  if (code === "cookie_sync_payload_too_large") return "同步失败：Cookie 总量超过本地接口上限。";
  return "同步失败，请稍后重试。";
}

syncButton.addEventListener("click", () => {
  syncButton.disabled = true;
  statusElement.textContent = "正在同步…";
  chrome.runtime.sendMessage({ type: "sync-all-chrome-cookies" }, (response) => {
    syncButton.disabled = false;
    if (chrome.runtime.lastError || !response?.ok) {
      statusElement.textContent = safeFailureText(response?.error);
      return;
    }
    statusElement.textContent = [
      `总条数：${Number(response.totalCount || 0)}`,
      `域数：${Number(response.domainCount || 0)}`,
      `跳过数：${Number(response.skippedCount || 0)}`
    ].join("\n");
  });
});
