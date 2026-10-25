-- 21-INT WhatsApp stepper, step 5 "Staff routing" (plan §6.9): how a channel assigns new conversations.
--
--   manual       nobody is assigned until a staff member takes the conversation (today's behaviour, the default)
--   round_robin  the active member with connect:reply who was assigned a conversation least recently
--   by_branch    the same, among members whose branch access includes the channel's branch
--
-- Applied by ConversationsService when a conversation is created (apps/api connect module). Tenant data under the
-- existing messaging_channels RLS (branch-scoped); no new privilege.
--
-- Reverse: alter table public.messaging_channels drop column routing;

alter table public.messaging_channels add column routing text not null default 'manual'
  check (routing in ('manual', 'round_robin', 'by_branch'));
