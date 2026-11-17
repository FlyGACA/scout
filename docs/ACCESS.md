# Who can open the site

The site is a set of static files served by a Cloudflare Worker named `scout`. A sign-in form written into the pages would not protect them: `data.json` and every other file would still answer to anyone who knows the address. The gate therefore sits in front of the whole Worker, at Cloudflare, and nothing in this repository implements it.

**Status on 2026-11-17: applied.** A Cloudflare Access application, "Fly GACA Scout (members only)", protects the `scout` Worker through one destination of type Worker. It covers `scout.flygaca.com`, the Worker's `workers.dev` address and its preview URLs through that one destination. It uses the account's one-time-PIN sign-in and the shared Allow policy "Company domain and named members", which includes the company's email domain and a named list kept in Cloudflare. The same policy is attached to the Office, Airspace, C172, Ufuq, Prompt Library and Skills applications, so a person is added or removed once.

The application was created and checked on 2026-11-17. Requests from outside to `/` and to a file that does not exist on `scout.flygaca.com` answered 302 to the Access sign-in (status codes only).

Not established by this record:

- That a member can sign in end to end. That needs a person with their own email.
- That a preview URL is covered. The documentation says a Worker destination covers previews, but nobody has requested one.

## The rule

One Cloudflare Access application for the Worker, with one Allow policy that includes:

- every address ending in the company's email domain, and
- a named list of invited addresses outside that domain.

Sign-in is by a one-time code sent to the person's email. Nobody else gets past Cloudflare, so no file is served to them.

## Steps to rebuild or check it (owner, in the Cloudflare dashboard)

Cloudflare renames its menus from time to time. Follow the current pages rather than this list where they differ: [self-hosted applications](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/), [Access policies](https://developers.cloudflare.com/cloudflare-one/policies/access/), [one-time PIN](https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/).

1. Open Zero Trust, then Access, then Applications, and add a self-hosted application.
2. Add one destination of type **Worker** and choose the `scout` Worker, so the hostname, the `workers.dev` address and previews are covered together.
3. Under sign-in methods, enable **One-time PIN**.
4. Attach the shared Allow policy "Company domain and named members".
5. Save, then open the site in a private window. It must ask for an email before showing anything, and `/data.json` must ask too.

To add or remove a person later, edit the named list in that shared policy. Removing someone takes effect when their session ends; revoke their session under Access, Users, to end it at once.

Keep the list of people in Cloudflare. Do not write addresses, account identifiers or tokens into this repository.

## What the pages do with it

Behind Access, Cloudflare answers `/cdn-cgi/access/get-identity` with the signed-in person. `site/ufuq/ufuq.shell.js` reads it, shows the email in the header and reveals a sign-out link to `/cdn-cgi/access/logout`. In a local preview, or while the gate is not applied, that address does not answer and the header shows neither.
