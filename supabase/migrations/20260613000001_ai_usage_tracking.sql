-- Track every Claude API call, linked to user / plan / takeoff
CREATE TABLE ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES house_plans(id) ON DELETE SET NULL,
  takeoff_id UUID REFERENCES takeoffs(id) ON DELETE SET NULL,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ai_usage_user_id_idx ON ai_usage(user_id);
CREATE INDEX ai_usage_plan_id_idx ON ai_usage(plan_id) WHERE plan_id IS NOT NULL;
CREATE INDEX ai_usage_takeoff_id_idx ON ai_usage(takeoff_id) WHERE takeoff_id IS NOT NULL;

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ai_usage" ON ai_usage
  FOR SELECT USING (auth.uid() = user_id);

-- Rollup by takeoff (all operations for one takeoff card)
CREATE VIEW takeoff_token_usage AS
SELECT
  takeoff_id,
  SUM(input_tokens)::INTEGER AS input_tokens,
  SUM(output_tokens)::INTEGER AS output_tokens,
  SUM(cache_creation_input_tokens)::INTEGER AS cache_creation_input_tokens,
  SUM(cache_read_input_tokens)::INTEGER AS cache_read_input_tokens,
  SUM(input_tokens + output_tokens)::INTEGER AS total_tokens
FROM ai_usage
WHERE takeoff_id IS NOT NULL
GROUP BY takeoff_id;

-- Rollup by plan / project
CREATE VIEW plan_token_usage AS
SELECT
  plan_id,
  SUM(input_tokens)::INTEGER AS input_tokens,
  SUM(output_tokens)::INTEGER AS output_tokens,
  SUM(cache_creation_input_tokens)::INTEGER AS cache_creation_input_tokens,
  SUM(cache_read_input_tokens)::INTEGER AS cache_read_input_tokens,
  SUM(input_tokens + output_tokens)::INTEGER AS total_tokens
FROM ai_usage
WHERE plan_id IS NOT NULL
GROUP BY plan_id;

-- Rollup by user (the number Stripe billing will consume)
CREATE VIEW user_token_usage AS
SELECT
  user_id,
  SUM(input_tokens)::INTEGER AS input_tokens,
  SUM(output_tokens)::INTEGER AS output_tokens,
  SUM(cache_creation_input_tokens)::INTEGER AS cache_creation_input_tokens,
  SUM(cache_read_input_tokens)::INTEGER AS cache_read_input_tokens,
  SUM(input_tokens + output_tokens)::INTEGER AS total_tokens
FROM ai_usage
GROUP BY user_id;
