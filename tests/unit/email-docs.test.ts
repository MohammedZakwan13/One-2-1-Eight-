import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync('docs/EMAIL_SETUP.md', 'utf8');
const section = (from: string, to: string) => doc.slice(doc.indexOf(from), doc.indexOf(to));
const cron = section('## 5. Cron job', '## 6. Monitoring');
const commands = [...cron.matchAll(/```\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');

describe('D1: the documented cron setup never exposes the secret', () => {
  it('no documented command puts a secret value in a command line (no echo / tee / literal header with a value)', () => {
    expect(doc).not.toMatch(/echo\s+["']?x-email-retry-secret/i);
    expect(doc).not.toMatch(/\|\s*sudo tee\s+\/etc\/one2oneight/);
    expect(commands).not.toMatch(/x-email-retry-secret:\s*[A-Za-z0-9<]/); // the only place the name appears is inside printf "...: %s\n"
    expect(commands).not.toMatch(/EMAIL_RETRY_SECRET=[A-Za-z0-9<]/);
  });
  it('the secret is generated on the server or read from a hidden prompt, and written with the printf builtin', () => {
    expect(commands).toContain('openssl rand -hex 32');
    expect(commands).toContain('read -r -s');
    expect(commands).toMatch(/printf "x-email-retry-secret: %s\\n" "\$s"/);
    expect(commands).toContain('umask 077');
  });
  it('the header file is root-owned with mode 600, and the doc tells you how to check it without printing the secret', () => {
    expect(commands).toContain('chown root:root /etc/one2oneight-email-retry.header');
    expect(commands).toContain('chmod 600 /etc/one2oneight-email-retry.header');
    expect(commands).toContain("grep -c '^EMAIL_RETRY_SECRET='");
  });
  it('curl reads the header from the file and the URL carries no secret', () => {
    expect(commands).toContain('-H @/etc/one2oneight-email-retry.header');
    expect(commands).toMatch(/http:\/\/127\.0\.0\.1:3000\/api\/internal\/email-retry(\s|$)/);
    expect(commands).not.toMatch(/email-retry\?/);
  });
  it('the log destination is root-only and the doc warns against set -x / curl -v', () => {
    expect(commands).toContain('install -m 640 -o root -g root /dev/null /var/log/one2oneight-email-retry.log');
    expect(cron).toMatch(/set -x/);
  });
});

describe('D3: the documented cron entry cannot overlap', () => {
  const entry = commands.split('\n').find(line => line.startsWith('*/5 * * * *')) ?? '';
  it('is a single every-five-minutes line under flock -n', () => {
    expect(entry).toMatch(/^\*\/5 \* \* \* \* \/usr\/bin\/flock -n \/run\/lock\/one2oneight-email-retry\.lock /);
  });
  it('allows more time than the 40-second worker budget plus an in-flight send', () => {
    expect(entry).toMatch(/--max-time 90/);
  });
});

describe('D2: the roll-out checklist includes the read-only preview of what the first run would recover', () => {
  const rollout = doc.slice(doc.indexOf('## 7. Roll-out checklist'));
  it('previews only the confirmation and the latest status, and states old skipped rows are not replayed', () => {
    expect(rollout).toContain('row_number() over (partition by h.order_id');
    expect(rollout).toContain("not (h.to_status = 'cancelled' and h.actor_type = 'system')");
    expect(rollout).toMatch(/skipped_unconfigured[\s\S]*not[\s\S]*replayed/);
  });
});

describe('Resend-only documentation and public wording', () => {
  const policy = readFileSync('docs/privacy-policy.txt', 'utf8');
  const withoutAddress = (text: string) => text.replace(/one21eight@gmail\.com/g, '');
  it('EMAIL_SETUP.md documents the Resend configuration and mentions no Gmail API, Google Cloud or OAuth', () => {
    for (const name of ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_REPLY_TO', 'INTERNAL_NOTIFICATION_EMAIL', 'RESEND_WEBHOOK_SECRET', 'EMAIL_RETRY_SECRET']) expect(doc).toContain(`\`${name}\``);
    expect(doc).toContain('orders@send.one21eight.com');
    expect(withoutAddress(doc).replace(/The old `GMAIL_\*` variables no longer exist\./, '')).not.toMatch(/gmail|oauth|google cloud|googleapis/i);
  });
  it('the DNS section gives no invented record values and says to copy them from the Resend dashboard', () => {
    const dns = section('## 2. Resend setup', '## 3. Environment');
    expect(dns).toMatch(/Copy them exactly from the dashboard/);
    expect(dns).not.toMatch(/v=spf1|amazonses|_domainkey|p=MIG/i);
  });
  it('the privacy policy names Resend and the planned sender, says sending is not yet enabled, and has no Google API or OAuth text', () => {
    expect(policy).toContain('Resend');
    expect(policy).toContain('orders@send.one21eight.com');
    expect(policy).toMatch(/Transactional email sending is not yet enabled/);
    expect(withoutAddress(policy)).not.toMatch(/gmail|google|oauth|limited use/i);
  });
  it('the privacy policy is plain text: no Markdown, bare URLs and addresses only', () => {
    expect(policy).not.toMatch(/\]\(|\[|\]|\*\*|`|^#|^\s*[-*>] /m);
    expect(policy).not.toContain('\r');
  });
});
