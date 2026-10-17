// Broad American English letter names, not a guess that these codes are words.
// Keep the source spelling and meaning input unchanged. Only pronunciation changes.
export const KNOWN_PRONUNCIATIONS = {
  atl: 'eɪtiɛl',
  katl: 'keɪeɪtiɛl',
  rcc: 'ɑɹsisi',
  parkatl: 'pɑɹkeɪtiɛl',
};
const source = 'gev-airport-letter-names-v1';

/** Repair queued/rejected airport codes once; vector generation keeps its budget. */
export async function prepareKnownPronunciations(client, profile) {
  const changed = [];
  for (const [token, ipa] of Object.entries(KNOWN_PRONUNCIATIONS)) {
    const result = await client.query(
      `UPDATE gev_gis_word_vectors SET ipa=$3,pronunciation=$4,vector=NULL,generated_at=NULL,
      blocked=false,error=NULL,failures=0,retry_at=0
      WHERE token=$1 AND profile=$2 AND pronunciation->>'source' IS DISTINCT FROM $5 RETURNING token`,
      [
        token,
        profile,
        ipa,
        {
          ipa,
          source,
          alternatives: [],
          method: 'English letter names; ParkATL retains the spoken word park.',
        },
        source,
      ],
    );
    if (result.rowCount) changed.push(token);
  }
  if (!changed.length) return 0;
  await client.query(
    `UPDATE gev_gis_names SET pronunciation_error=NULL WHERE tokens && $1::text[]
    AND pronunciation_error='One or more words were rejected by the pronunciation service.'`,
    [changed],
  );
  await client.query(
    `UPDATE gev_gis_name_vectors v SET phonetic=NULL,phonetic_at=NULL FROM gev_gis_names n
    WHERE v.name_id=n.id AND v.profile=$1 AND n.tokens && $2::text[]`,
    [profile, changed],
  );
  return changed.length;
}
