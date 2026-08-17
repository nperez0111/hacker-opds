/**
 * Small covers for suites that build books.
 *
 * Cover cost is a function of pixel count: a full 1000x1600 cover is ~115ms of
 * rasterising and requantising, and the EPUB suites build a couple of dozen
 * books, which is seconds of test time buying nothing - the code path is
 * identical at any size. Suites that care about a book call `useSmallCovers()`
 * and get covers a tenth of the width; `tests/cover.test.ts` leaves the scale
 * alone and asserts the real dimensions and the real bytes.
 *
 * Same bargain, and the same shape, as `setSvgFontOptionsForTests` in
 * `~/epub/images`.
 */
import { setCoverScaleForTests } from "~/epub/cover";

/** 0.1 renders a 100x160 cover: every layout branch, ~2ms. */
export function useSmallCovers(scale = 0.1): void {
  setCoverScaleForTests(scale);
}

/** Restores full-size covers. Call from `afterEach` to keep suites independent. */
export function restoreCoverScale(): void {
  setCoverScaleForTests(1);
}
