import path from 'node:path';

export const BOOK_FOLDER_LAYOUT = 'obsidian-book-folder/v1';
export const isImage = name => /\.(?:png|jpe?g|gif|svg|webp|bmp|avif)$/iu.test(name);
export function publishedAssetRelative(name) {
  const relative=path.posix.normalize(String(name).replace(/\\/gu,'/'));
  if(relative==='..'||relative.startsWith('../')||path.posix.isAbsolute(relative)||/^[a-z]:/iu.test(relative)) throw new Error('book_folder_asset_path_escape');
  return isImage(relative) ? relative.startsWith('images/') ? relative : path.posix.join('images',relative)
    : path.posix.join('_assets','source',relative);
}
export const assetReference = name => publishedAssetRelative(name).split('/').map(encodeURIComponent).join('/');
export function bookPublicationPath(requestedPath, source = {}) {
  const absolute=path.resolve(requestedPath);
  const requestedSlug=path.basename(absolute,'.md');
  const placeholder=/^(BV[0-9A-Za-z]{10})(（强结构化整理）|（普通书面化）|（完整图文强结构化）|（图文模式）)?$/u.exec(requestedSlug);
  let slug=requestedSlug;
  if(placeholder&&placeholder[1]===String(source.video_id||'').replace(/_p[1-9]\d*$/u,'')&&source.title?.trim()&&source.title!=='Unknown Title'){
    const title=source.title.replace(/[<>:"/\\|?*\x00-\x1f]/gu,'－').trim().replace(/[. ]+$/u,'');
    if(title)slug=(/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(title)?'_'+title:title)+(placeholder[2]||'');
  }
  const parent=path.basename(path.dirname(absolute))===requestedSlug ? path.dirname(path.dirname(absolute)) : path.dirname(absolute);
  return path.join(parent,slug,slug+'.md');
}
