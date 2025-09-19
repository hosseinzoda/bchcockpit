import * as env from '$env/static/public';
import { resolve  as appResolve, base } from '$app/paths';
export { asset, base } from '$app/paths';
import { ValueError } from '@cashlab/common';

const USING_HASH_ROUTER = env.PUBLIC_USE_HASH_ROUTER === '1';

export function resolve (id, params) {
  if (USING_HASH_ROUTER) {
    const query_mark_idx = id.indexOf('?');
    if (query_mark_idx !== -1) {
      id = id.substring(0, query_mark_idx) + '?' + encodeURIComponent(id.substring(query_mark_idx + 1));
    }
    let path = appResolve(id, params);
    if (base && path.startsWith(base)) {
      path = path.substring(base.length);
    }
    path = path.replace(/^\/+/, '');
    return base + '/' + (path ? '#/' + path : '')
  } else {
    return appResolve(id, params);
  }
}

export function stripBaseFromPath (path: string): string {
  if (!base) {
    return path;
  }
  if (!path.startsWith(base)) {
    throw new ValueError(`The provided path is not starting with base: ${base}`);
  }
  return path.substring(base.length);
}

export function pagePathToLink (path: string): string {
  return pageURLToLink(new URL(location.origin + base + '/' + path.replace(/^\/+/, '')));
}

export function pageURLToLink (url: URL): string {
  if (USING_HASH_ROUTER) {
    const url_str = url.toString();
    const base_link = location.origin + base + '/';
    if (!url_str.startsWith(base_link)) {
      throw new ValueError(`page url should start from the base, value: ${base_link}, got: ${url}`);
    }
    const path = '/' + url_str.substring(base_link.length);
    const path_query_idx = path.indexOf('?');
    if (path_query_idx !== -1)  {
      return base_link + '#' + path.substring(0, path_query_idx) + '?' + encodeURIComponent(path.substring(path_query_idx + 1))
    } else {
      return base_link + '#' + path;
    }
  }
  return url.toString();
}

export function pageURLFromLink (loc: string): URL {
  loc = loc+'';
  if (USING_HASH_ROUTER) {
    const hash_idx = loc.indexOf('#/');
    if (hash_idx !== -1) {
      const base_loc = loc.substring(0, hash_idx).replace(/\/+$/, '');
      if (base_loc.indexOf('?') !== -1) {
        throw new ValueError(`standard path queries are not allowed when hash router mode is active`);
      }
      const hash_part = loc.substring(hash_idx + 1);
      const hash_query_idx = hash_part.indexOf('?');
      if (hash_query_idx !== -1) {
        loc = base_loc + hash_part.substring(0, hash_query_idx) + '?' + decodeURIComponent(hash_part.substring(hash_query_idx + 1));
      } else {
        loc = base_loc + hash_part;
      }
    }
    return new URL(loc);
  } else {
    return new URL(loc);
  }
}
