import { cityKey } from './normalize.js';
import { lookupIndex } from './lookup.js';
import { EMBEDDING_PROFILE, NAME_RECIPE } from './embeddings/names.js';
import { createSearchEmbeddings } from './search-embeddings.js';
import {
  compatibleStreet,
  streetParts,
  searchParts,
  spellingSimilarity,
  pronunciationSimilarity,
} from './search-matching.js';
import { annotateZones } from './search-zones.js';

const round = (value) =>
  value == null ? null : Math.round(value * 10000) / 10000;
const NAME_LIMIT = 20_000;

export function createNameSearch(store, options = {}) {
  const embed = options.embed || createSearchEmbeddings(store, options);
  const inFlight = new Map();
  async function search(query) {
    const parts = searchParts(query);
    if (!parts) return { candidates: [], warnings: [], coverage: null };
    // Deduplicated, explicitly city-scoped source names, including incomplete
    // embeddings. Never narrow by spelling before looking for sound-alikes.
    const rows = (
      await store.pool.query(
        `SELECT n.id,n.kind,n.name_key,n.display_name,n.tokens,
      v.semantic IS NOT NULL AS has_semantic,v.phonetic IS NOT NULL AS has_phonetic
      FROM gev_gis_names n LEFT JOIN gev_gis_name_vectors v ON v.name_id=n.id AND v.profile=$1
      WHERE n.kind=$2 AND n.recipe=$3 AND EXISTS (
        SELECT 1 FROM gev_gis_feature_names fn JOIN gev_gis_features f USING(source_id,object_id)
        WHERE fn.name_id=n.id AND f.city_keys @> ARRAY[$4]::text[] AND f.region=$5)
      ORDER BY n.id LIMIT $6`,
        [
          EMBEDDING_PROFILE,
          parts.names[0].kind,
          NAME_RECIPE,
          cityKey(query.city),
          query.region,
          NAME_LIMIT + 1,
        ],
      )
    ).rows;
    const truncated = rows.length > NAME_LIMIT;
    const names = rows.slice(0, NAME_LIMIT);
    const coverage = {
      indexedNames: names.length,
      meaningNames: names.filter((row) => row.has_semantic).length,
      pronunciationNames: names.filter((row) => row.has_phonetic).length,
      truncated,
      cityInventoryComplete: false,
      candidateSearchComplete: false,
      limits: {
        cityNames: NAME_LIMIT,
        rankedNamesPerComponent: 12,
        combinations: 24,
        returnedCandidates: 10,
      },
      eligibleNames: [],
      note: 'Coverage describes published, prepared names in this city; it does not prove that every real location has been indexed.',
    };
    const warnings = new Set();
    if (truncated)
      warnings.add(
        'City name search limit reached; candidate inventory is incomplete.',
      );
    if (!names.length)
      return { candidates: [], coverage, warnings: [...warnings] };
    const prepared = await embed(parts.names, warnings);
    async function rank(name, vectors) {
      const street = name.kind === 'STREET' ? streetParts(name.display) : null;
      const eligible = names.filter(
        (row) =>
          !street || compatibleStreet(street, streetParts(row.display_name)),
      );
      coverage.eligibleNames.push({
        queryName: name.display,
        count: eligible.length,
      });
      if (!eligible.length) return [];
      const spelling = new Map(
        eligible.map((row) => [
          row.id,
          spellingSimilarity(
            street ? street.core.join(' ') : name.key,
            street
              ? streetParts(row.display_name).core.join(' ')
              : row.name_key,
          ),
        ]),
      );
      const ids = eligible.map((row) => row.id);
      const scored =
        vectors.phonetic || vectors.semantic
          ? (
              await store.pool.query(
                `WITH scores AS (
        SELECT name_id,
        CASE WHEN $3::real[] IS NOT NULL AND phonetic IS NOT NULL THEN
          (SELECT sum(a::double precision*b::double precision) FROM unnest(phonetic,$3::real[]) u(a,b)) END AS phonetic,
        CASE WHEN $4::real[] IS NOT NULL AND semantic IS NOT NULL THEN
          (SELECT sum(a::double precision*b::double precision) FROM unnest(semantic,$4::real[]) u(a,b)) END AS semantic
        FROM gev_gis_name_vectors WHERE profile=$1 AND name_id=ANY($2::bigint[])
      ) (SELECT * FROM scores WHERE phonetic IS NOT NULL ORDER BY phonetic DESC,name_id LIMIT 48)
      UNION (SELECT * FROM scores WHERE semantic IS NOT NULL ORDER BY semantic DESC,name_id LIMIT 24)`,
                [EMBEDDING_PROFILE, ids, vectors.phonetic, vectors.semantic],
              )
            ).rows
          : [];
      const shortlist = new Map(scored.map((row) => [row.name_id, row]));
      for (const row of [...eligible]
        .sort(
          (a, b) =>
            spelling.get(b.id) - spelling.get(a.id) ||
            a.name_key.localeCompare(b.name_key),
        )
        .slice(0, 24))
        if (!shortlist.has(row.id))
          shortlist.set(row.id, {
            name_id: row.id,
            semantic: null,
            phonetic: null,
          });
      const chosen = eligible.filter((row) => shortlist.has(row.id));
      const tokens = [...new Set(chosen.flatMap((row) => row.tokens))];
      const wordRows = (
        await store.pool.query(
          'SELECT token,vector FROM gev_gis_word_vectors WHERE profile=$1 AND token=ANY($2::text[]) AND vector IS NOT NULL',
          [EMBEDDING_PROFILE, tokens],
        )
      ).rows;
      const words = new Map(wordRows.map((row) => [row.token, row.vector]));
      return chosen
        .map((row) => {
          const phonetic = pronunciationSimilarity(
            street ? street.core : name.tokens,
            street ? streetParts(row.display_name).core : row.tokens,
            vectors.words,
            words,
          );
          const semantic = shortlist.get(row.id).semantic;
          const spell = spelling.get(row.id);
          const exact = name.key === row.name_key;
          // Meaning alone is insufficient to replace a proper name. Phonetic
          // alignment omits road types/directions already enforced as constraints.
          const plausible =
            exact ||
            spell >= 0.7 ||
            (phonetic !== null &&
              (phonetic >= 0.94 || (phonetic >= 0.82 && spell >= 0.35)));
          let weighted = 0.25 * spell,
            weight = 0.25;
          if (phonetic !== null) {
            weighted += 0.6 * Math.max(0, phonetic);
            weight += 0.6;
          }
          if (semantic !== null) {
            weighted += 0.15 * Math.max(0, semantic);
            weight += 0.15;
          }
          const score = exact ? 1 : weighted / weight;
          return {
            ...row,
            plausible,
            score,
            evidence: {
              nameId: String(row.id),
              indexedName: row.display_name,
              exactName: exact,
              phoneticSimilarity: round(phonetic),
              semanticSimilarity: round(semantic),
              spellingSimilarity: round(spell),
            },
          };
        })
        .filter((row) => row.plausible)
        .sort(
          (a, b) => b.score - a.score || a.name_key.localeCompare(b.name_key),
        )
        .slice(0, 12);
    }
    // Keep calls sequential to avoid simultaneous inference requests.
    const ranked = [];
    for (let i = 0; i < parts.names.length; i++)
      ranked.push(await rank(parts.names[i], prepared[i]));
    const combinations =
      parts.names.length === 2
        ? ranked[0]
            .slice(0, 6)
            .flatMap((a) => ranked[1].slice(0, 6).map((b) => [a, b]))
        : ranked[0].map((row) => [row]);
    combinations.sort(
      (a, b) =>
        b.reduce((s, n) => s + n.score, 0) - a.reduce((s, n) => s + n.score, 0),
    );
    let candidates = [];
    for (const combo of combinations.slice(0, 24)) {
      const address =
        parts.names.length === 2
          ? combo.map((row) => row.display_name).join(' & ')
          : `${parts.number ? `${parts.number} ` : ''}${combo[0].display_name}${parts.unit}`;
      const suggestedQuery = { ...query, address };
      // Resolve the corrected name against actual address points/connected roads.
      // This eliminates impossible house numbers and unconnected intersections.
      const found = await lookupIndex(store.pool, suggestedQuery, store.now());
      if (!found) continue;
      for (const candidate of found.candidates)
        candidates.push({
          ...candidate,
          suggestedQuery,
          match: {
            method: 'indexed-name-suggestion',
            profile: EMBEDDING_PROFILE,
            requiresConfirmation: true,
            rankingScore: combo.reduce((s, n) => s + n.score, 0) / combo.length,
            components: combo.map((row) => row.evidence),
          },
        });
    }
    candidates = [
      ...new Map(
        candidates.map((row) => [
          `${row.sourceId}:${row.objectId}:${row.address}:${row.location.latitude}:${row.location.longitude}`,
          row,
        ]),
      ).values(),
    ];
    if (query.apdZone)
      candidates = await annotateZones(store, query, candidates, options);
    for (const row of candidates) {
      const evidence = row.apdZoneEvidence;
      const adjustment =
        evidence?.status === 'MATCH'
          ? 0.05
          : evidence?.status === 'MISMATCH'
            ? -0.08
            : 0;
      row.match.zoneAdjustment = adjustment;
      row.match.rankingScore = round(
        Math.max(0, Math.min(1, row.match.rankingScore + adjustment)),
      );
    }
    candidates.sort(
      (a, b) =>
        b.match.rankingScore - a.match.rankingScore ||
        a.address.localeCompare(b.address) ||
        a.sourceId.localeCompare(b.sourceId) ||
        a.objectId.localeCompare(b.objectId),
    );
    // Collapse duplicate source observations of the same place for the margin,
    // while keeping separate coordinates and all provenance in the response.
    for (const row of candidates) {
      const rival = candidates.find(
        (other) =>
          other !== row &&
          (other.address.toLowerCase() !== row.address.toLowerCase() ||
            Math.hypot(
              other.location.latitude - row.location.latitude,
              other.location.longitude - row.location.longitude,
            ) > 0.001),
      );
      const margin = rival
        ? row.match.rankingScore - rival.match.rankingScore
        : null;
      const coverageFactor = names.length
        ? coverage.pronunciationNames / names.length
        : 0;
      const uniqueness =
        margin === null
          ? 0.85
          : Math.max(0.5, Math.min(0.95, 0.6 + margin * 2));
      row.match.confidence = {
        score: Math.round(
          Math.min(
            89,
            100 *
              row.match.rankingScore *
              (0.7 + 0.3 * coverageFactor) *
              uniqueness *
              (row.stale ? 0.65 : 1) *
              (truncated ? 0.7 : 1),
          ),
        ),
        scale:
          'Heuristic 0–100 ranking support, not a probability or permission to save a geotag.',
        competingCandidates: candidates.length - 1,
        runnerUpMargin: round(margin),
      };
    }
    return {
      candidates: candidates.slice(0, 10),
      coverage,
      warnings: [...warnings],
    };
  }
  return async (query) => {
    const key = JSON.stringify(query);
    if (inFlight.has(key)) return inFlight.get(key);
    if (inFlight.size >= 2)
      return {
        candidates: [],
        coverage: null,
        warnings: ['Local name search busy; retry later.'],
      };
    const pending = search(query);
    inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(key);
    }
  };
}
