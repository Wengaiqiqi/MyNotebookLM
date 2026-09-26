ALTER TABLE model_profiles ADD COLUMN speech_voices_json TEXT
  CHECK (speech_voices_json IS NULL OR json_valid(speech_voices_json));
