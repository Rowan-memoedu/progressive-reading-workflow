export function repositoryConfig(value, publicBase) {
  if (!value || typeof value !== 'object') throw new Error('需要 GitHub 仓库设置');
  const url = new URL(value.url);
  const match = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash || !match) throw new Error('需要公开 GitHub 仓库地址');
  const branch = String(value.branch || 'main');
  if (!/^[\w./-]+$/u.test(branch) || branch.includes('..')) throw new Error('仓库分支无效');
  const contentRoot = String(value.content_root ?? 'src').replace(/\/$/u, '');
  if (contentRoot && (!/^[\w./-]+$/u.test(contentRoot) || contentRoot.split('/').some(p => !p || p === '..' || p === '.'))) throw new Error('仓库正文目录无效');
  const base = new URL(value.public_base || publicBase || `https://${match[1]}.github.io/${match[2]}/`);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('仓库网站地址无效');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return {url:`https://github.com/${match[1]}/${match[2]}`, owner:match[1], repo:match[2], branch, content_root:contentRoot, public_base:base.href};
}
