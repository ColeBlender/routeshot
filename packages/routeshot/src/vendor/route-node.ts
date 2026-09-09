// Adapted from expo/expo packages/expo-router/src/Route.tsx @ d461c0835dfdc9fad1688cf5c7c234a3c36b240e (MIT).
// Changes: kept only the RouteNode data model plus `findRouteNodeByName`/`getValidInitialRoute`;
// dropped every React and expo-server binding (contexts, hooks, the <Route> component) so the tree
// builder runs in plain Node, loosened the `loader`/`generateMetadata` types to `unknown`, and
// widened optional properties with `| undefined` for routeshot's `exactOptionalPropertyTypes`.

export type DynamicConvention = { name: string; deep: boolean; notFound?: boolean };

export type LoadedRoute = {
  ErrorBoundary?: unknown;
  SuspenseFallback?: unknown;
  default?: unknown;
  unstable_settings?: Record<string, any> | undefined;
  getNavOptions?: ((args: any) => any) | undefined;
  generateStaticParams?: (props: { params?: Record<string, string | string[]> }) => Record<
    string,
    string | string[]
  >[] | undefined;
  loader?: unknown;
  generateMetadata?: unknown;
};

export type LoadedMiddleware = Pick<LoadedRoute, 'default' | 'unstable_settings'>;

export type MiddlewareNode = {
  /** Context Module ID. Used to resolve the middleware module */
  contextKey: string;
  /** Loads middleware into memory. Returns the exports from +middleware.ts */
  loadRoute: () => Partial<LoadedMiddleware>;
};

export type RouteNode = {
  /** The type of RouteNode */
  type: 'route' | 'api' | 'layout' | 'redirect' | 'rewrite';
  /** Load a route into memory. Returns the exports from a route. */
  loadRoute: () => LoadedRoute;
  /** Loaded initial route name. */
  initialRouteName?: string | undefined;
  /** Nested routes */
  children: RouteNode[];
  /** Is the route a dynamic path */
  dynamic: null | DynamicConvention[];
  /** `index`, `error-boundary`, etc. Relative to the nearest `_layout.tsx` */
  route: string;
  /** Context Module ID, used for matching children. */
  contextKey: string;
  /** Redirect Context Module ID, used for matching children. */
  destinationContextKey?: string | undefined;
  /** Parent Context Module ID, used for matching static routes to their parent dynamic route. */
  parentContextKey?: string | undefined;
  /** Is the redirect permanent. */
  permanent?: boolean | undefined;
  /** Added in-memory */
  generated?: boolean | undefined;
  /** Internal screens like the directory or the auto 404 should be marked as internal. */
  internal?: boolean | undefined;
  /** File paths for async entry modules that should be included in the initial chunk request to ensure the runtime JavaScript matches the statically rendered HTML representation. */
  entryPoints?: string[] | undefined;
  /** HTTP methods for this route. If undefined, assumed to be ['GET'] */
  methods?: string[] | undefined;
  /** Middleware function for server-side request processing. Only present on the root route node. */
  middleware?: MiddlewareNode | undefined;
};

export function findRouteNodeByName(
  node: RouteNode | null | undefined,
  name: string | undefined
): RouteNode | undefined {
  return node?.children.find((child) => child.route === name);
}

export function getValidInitialRoute(
  node: RouteNode | null,
  initialRouteName = node?.initialRouteName,
  groupName?: string
): RouteNode | undefined {
  if (!node || !initialRouteName) {
    return undefined;
  }
  const route =
    findRouteNodeByName(node, initialRouteName) ||
    findRouteNodeByName(node, `${initialRouteName}/index`);
  if (!route) {
    throw new Error(
      `The initial route name "${initialRouteName}"${groupName ? ` for group "${groupName}"` : ''} was not found in the layout at "${node.contextKey}". ` +
        `Available routes are: ${node.children.map(({ route }) => `"${route}"`).join(', ')}. ` +
        'Set `unstable_settings.initialRouteName` to the name of a route in this layout.'
    );
  }
  return route;
}

/**
 * Metro's `require.context` shape.
 * Adapted from expo/expo packages/expo-router/src/types.ts @ d461c0835dfdc9fad1688cf5c7c234a3c36b240e (MIT).
 */
export interface RequireContext {
  /** Return the keys that can be resolved. */
  keys(): string[];
  (id: string): any;
  <T>(id: string): T;
  /** **Unimplemented:** Return the module identifier for a user request. */
  resolve(id: string): string;
  /** **Unimplemented:** Readable identifier for the context module. */
  id: string;
}
