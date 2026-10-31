/* ═══════════════════════════════════════════════════════════════════════
   The unsubscribe page — served in the browser from an email link.

   Same design language as tirbeo.com / the accounts app: Apple's grouped
   layout, system font (San Francisco on Apple platforms), the charcoal
   plate palette in both schemes, SF Symbols drawn inline. No external
   assets, no scripts beyond a theme boot — mail clients' privacy proxies
   and strict CSPs must never be able to break this page.

   Tamper-resistance is structural, not advisory: the address shown comes
   from the SIGNED token's owner (a server lookup), never from a form field
   or the query string. There is nothing for a visitor to edit.
   ═══════════════════════════════════════════════════════════════════════ */

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** SF Symbols artwork (monochrome paths), inlined so the page ships itself. */
const SYMBOLS = {
  envelope: '<path d="M3.79883 22.959L25.7812 22.959C28.3105 22.959 29.5898 21.6797 29.5898 19.1992L29.5898 3.76953C29.5898 1.2793 28.3105 0 25.7812 0L3.79883 0C1.2793 0 0 1.26953 0 3.76953L0 19.1992C0 21.6992 1.2793 22.959 3.79883 22.959ZM3.83789 21.2305C2.4707 21.2305 1.72852 20.5078 1.72852 19.1016L1.72852 3.85742C1.72852 2.46094 2.4707 1.72852 3.83789 1.72852L25.752 1.72852C27.0898 1.72852 27.8516 2.46094 27.8516 3.85742L27.8516 19.1016C27.8516 20.5078 27.0898 21.2305 25.752 21.2305ZM10.2637 12.5098L2.91992 18.9844C2.59766 19.2676 2.50977 19.6094 2.64648 19.9512C2.77344 20.2734 3.06641 20.4395 3.45703 20.4395L26.1328 20.4395C26.5234 20.4395 26.8164 20.2734 26.9434 19.9512C27.0801 19.6094 26.9922 19.2676 26.6699 18.9844L19.3262 12.5098L15.5957 15.7129C14.9414 16.2695 14.6484 16.2695 13.9941 15.7129ZM2.09961 18.1445L9.79492 11.4746L2.32422 4.39453C2.09961 4.17969 1.94336 4.13086 1.72852 4.13086L1.72852 19.1016C1.72852 18.6719 1.85547 18.3691 2.09961 18.1445ZM27.4707 4.39453L20.0098 11.4746L27.6953 18.1445C27.9395 18.3691 28.0664 18.6719 28.0664 19.1016L28.0664 4.13086C27.8516 4.13086 27.6953 4.17969 27.4707 4.39453ZM14.6484 14.1016C15.0098 14.4043 15.3809 14.4043 15.7422 14.1016L26.4062 4.55078C26.6504 4.33594 26.7285 4.16016 26.6895 3.94531C26.6406 3.73047 26.4746 3.57422 26.2305 3.57422L3.32031 3.57422C3.07617 3.57422 2.91016 3.73047 2.86133 3.94531C2.82227 4.16016 2.90039 4.33594 3.14453 4.55078Z" fill-opacity="0.85"/>',
  checkmarkSeal: '<path d="M18.8965 1.93359C19.2969 1.93359 19.6289 2.17773 19.7363 2.54883L20.5371 5.32227C21.2305 5.5957 21.8848 5.95703 22.4805 6.40625L25.2148 5.81055C25.5859 5.72266 25.9766 5.88867 26.1621 6.2207L27.6367 8.76953C27.8418 9.11133 27.7832 9.55078 27.4902 9.83398L25.5957 11.7285C25.6348 12.0801 25.6738 12.4414 25.6738 12.793C25.6738 13.1445 25.6348 13.5059 25.5957 13.8574L27.4902 15.752C27.7832 16.0352 27.8418 16.4746 27.6367 16.8164L26.1621 19.3652C25.9766 19.6973 25.5859 19.8633 25.2148 19.7754L22.4805 19.1797C21.8848 19.6289 21.2305 19.9902 20.5371 20.2637L19.7363 23.0371C19.6289 23.4082 19.2969 23.6523 18.8965 23.6523L16.0742 23.6523C15.6934 23.6523 15.3613 23.4082 15.2637 23.0566L14.4629 20.2637C13.7695 19.9902 13.125 19.6289 12.5195 19.1797L9.78516 19.7754C9.41406 19.8633 9.02344 19.6973 8.83789 19.3652L7.36328 16.8164C7.1582 16.4746 7.2168 16.0352 7.50977 15.752L9.4043 13.8574C9.36523 13.5059 9.32617 13.1445 9.32617 12.793C9.32617 12.4414 9.36523 12.0801 9.4043 11.7285L7.50977 9.83398C7.2168 9.55078 7.1582 9.11133 7.36328 8.76953L8.83789 6.2207C9.02344 5.88867 9.41406 5.72266 9.78516 5.81055L12.5195 6.40625C13.125 5.95703 13.7695 5.5957 14.4629 5.32227L15.2637 2.54883C15.3613 2.17773 15.6934 1.93359 16.0742 1.93359ZM17.4805 3.60352L16.8359 5.85938C16.6699 6.45508 16.2598 6.82617 15.6738 7.04102C14.9902 7.29492 14.3652 7.61719 13.7988 8.03711C13.3008 8.4082 12.793 8.55469 12.1777 8.4082L9.96094 7.89062L9.25781 9.0625L10.8984 10.7129C11.3574 11.1719 11.5039 11.6992 11.4453 12.2949C11.416 12.5879 11.3965 12.793 11.3965 12.998C11.3965 13.2031 11.416 13.4082 11.4453 13.7012C11.5039 14.2969 11.3574 14.8242 10.8984 15.2832L9.25781 16.9336L9.96094 18.1055L12.1777 17.5879C12.793 17.4414 13.3008 17.5879 13.7988 17.959C14.3652 18.3789 14.9902 18.7012 15.6738 18.9551C16.2598 19.1699 16.6699 19.541 16.8359 20.1367L17.4805 22.3926H18.7891L19.4336 20.1367C19.5996 19.541 20.0098 19.1699 20.5957 18.9551C21.2793 18.7012 21.9043 18.3789 22.4707 17.959C22.9688 17.5879 23.4766 17.4414 24.0918 17.5879L26.3086 18.1055L27.0117 16.9336L25.3711 15.2832C24.9121 14.8242 24.7656 14.2969 24.8242 13.7012C24.8535 13.4082 24.873 13.2031 24.873 12.998C24.873 12.793 24.8535 12.5879 24.8242 12.2949C24.7656 11.6992 24.9121 11.1719 25.3711 10.7129L27.0117 9.0625L26.3086 7.89062L24.0918 8.4082C23.4766 8.55469 22.9688 8.4082 22.4707 8.03711C21.9043 7.61719 21.2793 7.29492 20.5957 7.04102C20.0098 6.82617 19.5996 6.45508 19.4336 5.85938L18.7891 3.60352Z" fill-opacity="0.85"/><path d="M17.0215 16.6504C17.3145 16.9434 17.7051 17.0996 18.125 17.0996C18.5352 17.0996 18.9355 16.9434 19.2285 16.6504L22.9102 12.6172C23.4473 12.0312 23.4082 11.123 22.8125 10.5957C22.2266 10.0586 21.3184 10.0977 20.791 10.6934L18.125 13.623L16.1133 11.5234C15.5566 10.9668 14.6582 10.9668 14.1016 11.5234C13.5449 12.0801 13.5449 12.9785 14.1016 13.5352Z" fill-opacity="0.85"/>',
  xmarkCircle: '<path d="M12.7148 25.4395C19.7266 25.4395 25.4395 19.7266 25.4395 12.7246C25.4395 5.71289 19.7266 0 12.7148 0C5.71289 0 0 5.71289 0 12.7246C0 19.7266 5.71289 25.4395 12.7148 25.4395ZM17.9492 8.4668C18.418 7.97852 19.1699 7.97852 19.6387 8.45703C20.1074 8.92578 20.0977 9.6875 19.6191 10.1562L14.5801 15.2441L12.6953 17.1289L10.8105 15.2441L5.79102 10.166C5.30273 9.6875 5.30273 8.93555 5.77148 8.4668C6.25 7.98828 6.99219 7.98828 7.4707 8.45703L12.7148 13.7305Z" fill-opacity="0.85" transform="rotate(45 12.72 12.72)"/>',
  lock: '<path d="M8.21289 10.0195V7.91992C8.21289 5.43945 10.2246 3.41797 12.7051 3.41797C15.1758 3.41797 17.1973 5.43945 17.1973 7.91992V10.0195C18.6426 10.0195 19.6094 11.0742 19.6094 12.4609V18.7109C19.6094 20.0977 18.6426 21.1621 17.2461 21.1621L8.16406 21.1621C6.76758 21.1621 5.80078 20.0977 5.80078 18.7109L5.80078 12.4609C5.80078 11.0742 6.76758 10.0195 8.21289 10.0195ZM9.82422 10.0195L15.5859 10.0195V7.91992C15.5859 6.30859 14.3066 5.0293 12.7051 5.0293C11.0938 5.0293 9.82422 6.30859 9.82422 7.91992Z" fill-opacity="0.85"/>',
} as const;

function symbol(name: keyof typeof SYMBOLS, size = 26): string {
  const vb = name === 'envelope' ? '0 0 29.9512 22.959' : name === 'lock' ? '0 0 25.4102 24.5801' : '0 0 25.8008 25.459';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${Math.round(size * (parseFloat(vb.split(' ')[3]) / parseFloat(vb.split(' ')[2])))}" fill="currentColor" aria-hidden="true" focusable="false">${SYMBOLS[name]}</svg>`;
}

const CATEGORY_COPY: Record<string, { title: string; line: string }> = {
  all: { title: 'non-essential emails', line: "Product news, digests and tips stop immediately. Security alerts always arrive." },
  product: { title: 'product updates', line: "News about features and events stops. Everything else keeps coming." },
  forms: { title: 'forms and activity mail', line: 'Replies and form-related notices stop. Everything else keeps coming.' },
  support: { title: 'support mail', line: 'Ticket replies stop arriving by email. Everything else keeps coming.' },
};

export type UnsubscribePageState =
  | { kind: 'confirm'; token: string; address: string; category: string }
  | { kind: 'done'; category: string }
  | { kind: 'notice'; message: string };

export function renderUnsubscribePage(state: UnsubscribePageState): string {
  const copy = CATEGORY_COPY[state.kind === 'confirm' || state.kind === 'done' ? state.category : 'all'] ?? CATEGORY_COPY.all!;

  let hero: { icon: string; title: string; body: string };
  if (state.kind === 'confirm') {
    hero = {
      icon: symbol('envelope'),
      title: `Unsubscribe from ${copy.title}?`,
      body: `<p class="lede">${esc(copy.line)}</p>
        <div class="addr" title="This address comes from your signed link — it cannot be changed here.">
          <span class="addr-lock">${symbol('lock', 15)}</span>
          <span class="addr-mail">${esc(maskAddress(state.address))}</span>
        </div>
        <form method="POST" action="/api/emails/unsubscribe">
          <input type="hidden" name="token" value="${esc(state.token)}" />
          <button class="btn-danger" type="submit">Unsubscribe</button>
        </form>
        <a class="quiet" href="https://tirbeo.com/settings/notifications">Manage each category instead →</a>`,
    };
  } else if (state.kind === 'done') {
    hero = {
      icon: symbol('checkmarkSeal', 30),
      title: "You're unsubscribed",
      body: `<p class="lede">No more ${esc(copy.title)} will reach your inbox. Security alerts are always sent, and you can turn everything back on from your Tirbeo settings.</p>`,
    };
  } else {
    hero = {
      icon: symbol('xmarkCircle', 28),
      title: 'Something is not right',
      body: `<p class="lede">${esc(state.message)}</p>`,
    };
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"/>
<meta name="color-scheme" content="dark light"/>
<meta name="robots" content="noindex"/>
<title>Unsubscribe · Tirbeo</title>
<style>
:root{--bg:#1c1c1e;--plate-a:#303034;--plate-b:#2c2c2e;--fg:#ffffff;--text-3:#b6b6bd;--text-4:#a8a8af;--hair:rgba(255,255,255,.1);--danger:#ff5449;--danger-fg:#fff;--success:#32d74b;--link:#64a5ff;--focus:#0a84ff;--press:rgba(0,0,0,.28)}
@media (prefers-color-scheme:light){:root{--bg:#f2f2f7;--plate-a:#ffffff;--plate-b:#fbfbfe;--fg:#171717;--text-3:#5d5d66;--text-4:#6e6e76;--hair:rgba(18,19,22,.12);--danger:#d92f27;--success:#1ea64b;--link:#0068d6;--focus:#007aff;--press:rgba(18,19,22,.08)}}
*{margin:0;padding:0;box-sizing:border-box;min-width:0}
body{background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:17px;line-height:22px;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}
main{width:min(420px,100%)}
.card{background:linear-gradient(180deg,var(--plate-a),var(--plate-b));border:1px solid var(--hair);border-radius:20px;padding:36px 28px;text-align:center;box-shadow:0 1px 2px rgb(0 0 0/.4),0 18px 44px -22px rgb(0 0 0/.6)}
.ico{display:inline-flex;color:var(--text-3);margin-bottom:18px}
.ico.ok{color:var(--success)}
h1{font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.02em;margin-bottom:10px;text-wrap:balance}
.lede{font-size:15px;line-height:20px;color:var(--text-3);margin-bottom:22px;text-wrap:pretty}
.addr{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:12px;background:rgba(120,120,128,.16);border:1px solid var(--hair);font-size:15px;color:var(--fg);user-select:none;margin-bottom:18px}
.addr-lock{display:inline-flex;color:var(--text-4)}
.addr-mail{letter-spacing:-.01em}
.btn-danger{display:block;width:100%;min-height:44px;border:0;border-radius:10px;background:var(--danger);color:var(--danger-fg);font:inherit;font-size:15px;font-weight:600;letter-spacing:-.01em;cursor:pointer;transition:filter 120ms ease,transform 120ms ease}
.btn-danger:hover{filter:brightness(1.08)}
.btn-danger:active{transform:scale(.975);filter:brightness(.95)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.quiet{display:inline-block;margin-top:16px;font-size:15px;color:var(--link);text-decoration:none}
.quiet:hover{text-decoration:underline}
footer{margin-top:28px;text-align:center;font-size:12px;line-height:16px;color:var(--text-4)}
footer a{color:var(--text-3);text-decoration:none}
footer a:hover{text-decoration:underline}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
</style>
</head>
<body>
<main>
  <div class="card">
    <span class="ico${state.kind === 'done' ? ' ok' : ''}">${hero.icon}</span>
    <h1>${esc(hero.title)}</h1>
    ${hero.body}
  </div>
  <footer>tirbeo.com · security alerts are always delivered<br/>Questions? <a href="https://tirbeo.com/contact">Contact us</a></footer>
</main>
</body>
</html>`;
}

/** Show enough of the address to recognise it without fully exposing it. */
function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 1) return address;
  const local = address.slice(0, at);
  const masked = local.length <= 2 ? local[0] + '•' : `${local.slice(0, 2)}${'•'.repeat(Math.min(local.length - 3, 8))}${local.slice(-1)}`;
  return `${masked}${address.slice(at)}`;
}
