import { useEffect, useState } from 'react';

export type Route =
  | { page: 'orders' }
  | { page: 'order'; id: string }
  | { page: 'products' }
  | { page: 'settings' }
  | { page: 'simulator' };

function parse(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/orders';
  const order = /^\/orders\/([\w-]+)$/.exec(path);
  if (order) return { page: 'order', id: order[1]! };
  if (path.startsWith('/products')) return { page: 'products' };
  if (path.startsWith('/settings')) return { page: 'settings' };
  if (path.startsWith('/simulator')) return { page: 'simulator' };
  return { page: 'orders' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string) {
  window.location.hash = path;
}
