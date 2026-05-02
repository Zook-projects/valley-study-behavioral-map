// Top-level dataset selector. Two values today; designed to accommodate a
// third source later (RFTA boardings, ACS journey-to-work, etc.) without a
// rename — `dataset` stays generic where `lodes` / `placer` would not.

export type Dataset = 'commute' | 'visitors';
