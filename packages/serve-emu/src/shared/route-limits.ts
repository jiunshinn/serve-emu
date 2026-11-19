// Route limits shared by the UI's route-file parser and the server.

/** Most waypoints a route may have. The parser stops there; the server rejects more. */
export const MAX_ROUTE_WAYPOINTS = 10_000;

/**
 * One budget for a route's bytes, so a file the UI accepts stays within what
 * the server reads.
 */
const ROUTE_BYTES = 2 * 1024 * 1024;

/** Largest `POST /api/route` request body the server reads. */
export const MAX_ROUTE_BODY_BYTES = ROUTE_BYTES;

/** Largest route file (GPX, KML, GeoJSON) the UI parses. */
export const MAX_ROUTE_FILE_BYTES = ROUTE_BYTES;
