(() => {
  "use strict";

  const WGS84_SEMI_MAJOR_METERS = 6378137;
  const WGS84_ECCENTRICITY_SQUARED = 0.0066943799901413165;
  const WGS84_ECCENTRICITY = Math.sqrt(WGS84_ECCENTRICITY_SQUARED);
  const AUTHALIC_Q_AT_POLE = 1 - (1 - WGS84_ECCENTRICITY_SQUARED) / (2 * WGS84_ECCENTRICITY)
    * Math.log((1 - WGS84_ECCENTRICITY) / (1 + WGS84_ECCENTRICITY));
  const AUTHALIC_EARTH_RADIUS_METERS = WGS84_SEMI_MAJOR_METERS * Math.sqrt(AUTHALIC_Q_AT_POLE / 2);
  const boundaryUrl = "data/presov-boundary.geojson";
  let boundaryRequest;

  const authalicLatitudeRadians = (latitudeDegrees) => {
    const latitude = latitudeDegrees * Math.PI / 180;
    const sine = Math.sin(latitude);
    const q = (1 - WGS84_ECCENTRICITY_SQUARED) * (
      sine / (1 - WGS84_ECCENTRICITY_SQUARED * sine * sine)
      - Math.log((1 - WGS84_ECCENTRICITY * sine) / (1 + WGS84_ECCENTRICITY * sine)) / (2 * WGS84_ECCENTRICITY)
    );
    return Math.asin(Math.max(-1, Math.min(1, q / AUTHALIC_Q_AT_POLE)));
  };

  const ringAreaSquareMeters = (ring) => {
    let area = 0;
    for (let index = 0; index < ring.length - 1; index += 1) {
      const [longitude1, latitude1] = ring[index];
      const [longitude2, latitude2] = ring[index + 1];
      const latitude1Radians = authalicLatitudeRadians(latitude1);
      const latitude2Radians = authalicLatitudeRadians(latitude2);
      const longitudeDeltaRadians = (longitude2 - longitude1) * Math.PI / 180;
      area += longitudeDeltaRadians * (2 + Math.sin(latitude1Radians) + Math.sin(latitude2Radians));
    }
    return Math.abs(area * AUTHALIC_EARTH_RADIUS_METERS ** 2 / 2);
  };

  const polygonAreaSquareMeters = (polygon) => Math.max(0,
    ringAreaSquareMeters(polygon[0]) - polygon.slice(1).reduce((holesArea, hole) => holesArea + ringAreaSquareMeters(hole), 0)
  );

  const geometryAreaSquareMeters = (multiPolygon) => multiPolygon.reduce(
    (area, polygon) => area + polygonAreaSquareMeters(polygon), 0
  );

  const getTerritoryPolygons = (walks) => walks.flatMap((walk) => {
    if (!walk || walk.closed !== true || walk.mode === "expedition" || walk.status === "retreated" || !Array.isArray(walk.points)) return [];
    if (walk.points.some((point) => !Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)
      || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180)) return [];
    const ring = walk.points.map((point) => [point.lng, point.lat]);
    if (ring.length < 4) return [];
    if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push([...ring[0]]);
    return [[[ring]]];
  });

  const calculateCoverage = ({ boundaryGeometry, walks, polygonClipping }) => {
    if (!boundaryGeometry || !Array.isArray(boundaryGeometry.coordinates) || !polygonClipping?.union || !polygonClipping?.intersection) return null;
    const city = boundaryGeometry.type === "Polygon" ? [boundaryGeometry.coordinates]
      : boundaryGeometry.type === "MultiPolygon" ? boundaryGeometry.coordinates : null;
    if (!city?.length) return null;

    try {
      const cityArea = geometryAreaSquareMeters(city);
      if (!Number.isFinite(cityArea) || cityArea <= 0) return null;
      const territories = getTerritoryPolygons(Array.isArray(walks) ? walks : []);
      if (!territories.length) return { capturedArea: 0, cityArea, percentage: 0 };

      const mergedTerritories = territories.length === 1 ? territories[0] : polygonClipping.union(...territories);
      const insideCity = polygonClipping.intersection(city, mergedTerritories);
      const capturedArea = Math.min(cityArea, geometryAreaSquareMeters(insideCity));
      if (!Number.isFinite(capturedArea) || capturedArea < 0) return null;
      return { capturedArea, cityArea, percentage: capturedArea / cityArea * 100 };
    } catch {
      return null;
    }
  };

  const formatPercentage = (coverage) => {
    if (!coverage || !Number.isFinite(coverage.percentage)) return "—";
    const percentage = coverage.capturedArea >= coverage.cityArea
      ? 100
      : Math.min(99.99, Math.max(0, coverage.percentage));
    return `${percentage.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  };

  const loadBoundary = () => {
    if (!boundaryRequest) {
      boundaryRequest = fetch(boundaryUrl)
        .then((response) => {
          if (!response.ok) throw new Error("City boundary is unavailable");
          return response.json();
        })
        .then((feature) => feature?.geometry || null)
        .catch(() => null);
    }
    return boundaryRequest;
  };

  const calculate = async (walks, polygonClipping = typeof window !== "undefined" ? window.polygonClipping : undefined) => {
    const boundaryGeometry = await loadBoundary();
    return calculateCoverage({ boundaryGeometry, walks, polygonClipping });
  };

  const api = { loadBoundary, calculate, calculateCoverage, formatPercentage, geometryAreaSquareMeters };
  if (typeof window !== "undefined") window.WalkCityCoverage = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
