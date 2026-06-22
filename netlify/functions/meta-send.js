// TODO: Read PAGE_ACCESS_TOKEN from process.env
// TODO: Accept { leadId, recipientId, platform, message } from request body
// TODO: POST to https://graph.facebook.com/v19.0/me/messages (Instagram & Facebook)
// TODO: Insert sent message into lead_messages (direction: 'out')

exports.handler = async () => ({
  statusCode: 200,
  body: JSON.stringify({ status: 'ok' }),
});
