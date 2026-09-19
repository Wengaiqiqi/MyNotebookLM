ALTER TABLE model_profiles
ADD COLUMN context_tokens_override INTEGER
  CHECK (context_tokens_override IS NULL OR (context_tokens_override > 0 AND context_tokens_override <= 2147483647));

ALTER TABLE model_profiles
ADD COLUMN max_output_tokens_override INTEGER
  CHECK (max_output_tokens_override IS NULL OR (max_output_tokens_override > 0 AND max_output_tokens_override <= 2147483647));

ALTER TABLE model_profiles
ADD COLUMN generation_limits_json TEXT
  CHECK (generation_limits_json IS NULL OR json_valid(generation_limits_json));
