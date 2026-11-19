import { describe, expect, it } from 'vitest';
import { pickAccessToken, pickReqId, WidgetError } from '@/lib/msg91-widget';

describe('MSG91 widget reply parsing', () => {
  it('takes the reqId from the send response message', () => {
    expect(pickReqId({ type: 'success', message: '336870744532313134323444' })).toBe('336870744532313134323444');
  });
  it('rejects a send response without a usable reqId', () => {
    for (const reply of [{}, { message: '' }, { message: '   ' }, null, undefined]) expect(() => pickReqId(reply as never)).toThrow(WidgetError);
  });
  it('takes the access token (a JWT) from `message` or `access-token`', () => {
    expect(pickAccessToken({ type: 'success', message: 'aaa.bbb.ccc' })).toBe('aaa.bbb.ccc');
    expect(pickAccessToken({ type: 'success', message: 'OTP verified successfully', 'access-token': 'x.y.z' })).toBe('x.y.z');
  });
  it('refuses a verify reply that carries no token, so a status text is never posted as one', () => {
    expect(() => pickAccessToken({ type: 'success', message: 'OTP verified successfully' })).toThrow(WidgetError);
    expect(() => pickAccessToken({})).toThrow(WidgetError);
  });
});
