-- Bot success metrics (chatbot open #18) — paste into the Supabase SQL editor and
-- run weekly (read-only). Targets from the final plan §8.3 / #18:
--   ≥60% of lead handoffs carry phone + service + location/branch
--   zero "missed medical": no bot reply was sent to the message that triggered a
--   medical/emergency handoff (the safety layers must block those).
with handoffs as (
  select id, customer_name, bot_state
  from leads
  where bot_state->>'handoff_at' > now() - interval '7 days'
),
complete as (
  select * from handoffs
  where coalesce(bot_state->'qualification'->>'phone', '')    <> ''
    and coalesce(bot_state->'qualification'->>'service', '')  <> ''
    and (coalesce(bot_state->'qualification'->>'branch', '')   <> ''
      or coalesce(bot_state->'qualification'->>'location', '') <> '')
)
select
  (select count(*) from handoffs) as handoffs_7d,
  (select count(*) from complete) as handoffs_complete,
  round(100.0 * (select count(*) from complete)
        / nullif((select count(*) from handoffs), 0), 1) as pct_complete_target_60,
  (select count(*) from handoffs
    where bot_state->>'handoff_reason' in ('medical', 'emergency')) as safety_handoffs,
  (select count(*) from handoffs
    where bot_state->>'handoff_reason' = 'kb_miss') as kb_miss_handoffs,
  (select count(*) from handoffs
    where bot_state->>'handoff_reason' = 'turn_cap') as turn_cap_handoffs,
  -- target 0: an is_bot message NEWER than the thread's last inbound on a
  -- medical/emergency-handoff thread = the bot answered the very message that
  -- should have gone straight to staff (earlier normal bot replies don't count)
  (select count(*) from handoffs h
    where h.bot_state->>'handoff_reason' in ('medical', 'emergency')
      and exists (
        select 1 from lead_messages bot
        where bot.lead_id = h.id and bot.is_bot
          and bot.created_at > (select max(m.created_at) from lead_messages m
                                 where m.lead_id = h.id and m.direction = 'incoming')
      )) as missed_medical_target_0,
  (select count(*) from lead_messages
    where is_bot and created_at > now() - interval '7 days') as bot_messages_7d;
