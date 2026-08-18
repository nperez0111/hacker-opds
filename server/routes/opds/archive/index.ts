import { defineHandler } from "nitro/h3";
import { NAVIGATION_TYPE } from "~/opds/atom";
import { buildArchiveFeed } from "~/opds/catalog";
import { resolveBase } from "~/opds/origin";
import { feedResponse } from "~/opds/respond";

export default defineHandler((event) =>
  feedResponse(event, buildArchiveFeed(resolveBase(event)), NAVIGATION_TYPE),
);
