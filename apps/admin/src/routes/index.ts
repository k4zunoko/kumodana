import type { Route } from "../app.ts";
import { filesRoutes } from "./files.ts";
import { linksRoutes } from "./links.ts";
import { tagsRoutes } from "./tags.ts";
import { usageRoutes } from "./usage.ts";

/** Every admin API route, in registration order. */
export const routes: Route[] = [usageRoutes, filesRoutes, tagsRoutes, linksRoutes];
