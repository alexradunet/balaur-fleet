# Web: the Balaur home page at https://<domain>, for every device on the tailnet,
# and this machine's web UIs at https://<subdomain>.<domain>.
#
# The page lists each machine's web UIs (their `balaur.services` with a port)
# and installs as an app (web manifest). A service of this machine with a
# `subdomain` gets its own HTTPS address, proxied by Caddy to 127.0.0.1:<port>;
# the others link to their machine's fleet `address`. One wildcard certificate
# from Let's Encrypt covers all of it, by DNS challenge (NixOS's `security.acme`,
# lego), so nothing has to be reachable from the internet.
#
# Private by design: the domain's A record points at this machine's *tailnet*
# address, which only answers devices on the tailnet. The services have no
# logins, so never point it at a public address or forward ports to it.
#
# Set up once:
#   - DNS: A records <domain> and *.<domain> -> this machine's tailnetIp, at the
#     registrar (and no AAAA: IPv6 would win and go somewhere else).
#   - A DNS API token that lego can use (the host file wires it from sops):
#     `dnsProvider` names lego's provider, the credentials file its variables.
{ config, ... }:
let
  fleet = config.fleet;
  nixosConfigs = config.flake.nixosConfigurations;
in
{
  flake.modules.nixos.web =
    { config, lib, pkgs, ... }:
    let
      cfg = config.balaur.web;
      me = config.networking.hostName;
      esc = lib.escapeXML;

      # Every machine's web UIs, this one first. Ours from our own config, the
      # others' from theirs (lazy: nothing in balaur.services reads this page).
      servicesOf = host:
        if host == me then config.balaur.services
        else nixosConfigs.${host}.config.balaur.services;
      hosts = [ me ] ++ lib.filter (h: h != me && fleet ? ${h}) (lib.attrNames nixosConfigs);
      address = host: fleet.${host}.address or host;
      # This machine's web UIs with a subdomain get https://<subdomain>.<domain>
      # through Caddy; the other machines' keep their plain address.
      proxied = lib.filter (s: s.port != null && s.subdomain != null) config.balaur.services;
      url = host: s:
        if host == me && s.subdomain != null then "https://${s.subdomain}.${cfg.domain}${s.path}"
        else "http://${address host}:${toString s.port}${s.path}";
      # Emoji show as they are; icon names and files mean nothing to a browser.
      icon = s: if builtins.match "[[:alnum:]/._-]+" s.icon != null then "•" else s.icon;
      card = host: s: ''
        <a class="card" href="${esc (url host s)}">
          <span class="icon">${esc (icon s)}</span>
          <span class="text"><span class="name">${esc s.name}</span>
          <span class="desc">${esc s.description}</span></span>
        </a>'';
      section = host:
        let web = lib.filter (s: s.port != null) (servicesOf host);
        in lib.optionalString (web != [ ]) ''
          <section>
            <h2>On ${esc host}</h2>
            <div class="grid">
          ${lib.concatMapStrings (card host) web}
            </div>
          </section>'';

      page = pkgs.writeText "index.html" ''
        <!doctype html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Balaur</title>
          <link rel="manifest" href="/manifest.webmanifest">
          <link rel="icon" href="/icon.svg" type="image/svg+xml">
          <meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)">
          <meta name="theme-color" content="#242424" media="(prefers-color-scheme: dark)">
          <style>
            :root { --bg: #fafafa; --card: #ffffff; --fg: #1e1e1e; --dim: #5e5c64;
                    --line: #deddda; --accent: #3584e4; color-scheme: light dark; }
            @media (prefers-color-scheme: dark) {
              :root { --bg: #242424; --card: #303030; --fg: #ffffff; --dim: #c0bfbc;
                      --line: #3d3d3d; --accent: #78aeed; }
            }
            * { box-sizing: border-box; }
            body { margin: 0; background: var(--bg); color: var(--fg);
                   font: 16px/1.4 Cantarell, "Adwaita Sans", system-ui, sans-serif; }
            main { max-width: 860px; margin: 0 auto; padding: 32px 16px 48px; }
            header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
            header img { width: 56px; height: 56px; }
            h1 { margin: 0; font-size: 28px; }
            header p { margin: 2px 0 0; color: var(--dim); }
            h2 { font-size: 15px; font-weight: 700; color: var(--dim); margin: 28px 0 10px; }
            .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
            .card { display: flex; align-items: center; gap: 14px; padding: 14px 16px;
                    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
                    color: inherit; text-decoration: none; }
            .card:hover, .card:focus-visible { border-color: var(--accent); outline: none; }
            .icon { font-size: 28px; width: 36px; text-align: center; }
            .text { display: flex; flex-direction: column; min-width: 0; }
            .name { font-weight: 700; }
            .desc { color: var(--dim); font-size: 14px; }
            footer { margin-top: 36px; color: var(--dim); font-size: 13px; }
          </style>
        </head>
        <body>
          <main>
            <header>
              <img src="/icon.svg" alt="">
              <div><h1>Balaur</h1><p>The home's services</p></div>
            </header>
        ${lib.concatMapStrings section hosts}
            <footer>Only devices on the tailnet can open these.</footer>
          </main>
        </body>
        </html>
      '';

      manifest = pkgs.writeText "manifest.webmanifest" (builtins.toJSON {
        name = "Balaur";
        short_name = "Balaur";
        description = "The home's services";
        start_url = "/";
        scope = "/";
        display = "standalone";
        background_color = "#fafafa";
        theme_color = "#3584e4";
        icons = [{ src = "/icon.svg"; sizes = "any"; type = "image/svg+xml"; purpose = "any"; }];
      });

      site = pkgs.runCommand "balaur-web" { } ''
        mkdir $out
        cp ${page} $out/index.html
        cp ${manifest} $out/manifest.webmanifest
        cp ${../gnome/app/data/org.balaur.Balaur.svg} $out/icon.svg
      '';
    in
    {
      options.balaur.web = {
        domain = lib.mkOption {
          type = lib.types.str;
          example = "balaur.space";
          description = "The domain the home page is served at. Its A record points at this machine's tailnet address.";
        };
        dnsProvider = lib.mkOption {
          type = lib.types.str;
          example = "gandiv5";
          description = "lego's name for the DNS provider (https://go-acme.github.io/lego/dns/), for the certificate's DNS challenge.";
        };
        dnsCredentialsFile = lib.mkOption {
          type = lib.types.path;
          description = "Environment file with the provider's API credentials (for Gandi: GANDIV5_PERSONAL_ACCESS_TOKEN=...).";
        };
      };

      config = {
        security.acme = {
          acceptTerms = true;
          certs.${cfg.domain} = {
            inherit (cfg) dnsProvider;
            environmentFile = cfg.dnsCredentialsFile;
            # One wildcard for every subdomain: new services need no new
            # certificate, and their names stay out of the public CT logs.
            extraDomainNames = [ "*.${cfg.domain}" ];
          };
        };

        services.caddy = {
          enable = true;
          virtualHosts = {
            ${cfg.domain} = {
              useACMEHost = cfg.domain;
              extraConfig = ''
                root * ${site}
                file_server
                header Cache-Control "no-cache"
              '';
            };
          } // lib.listToAttrs (map (s: lib.nameValuePair "${s.subdomain}.${cfg.domain}" {
            useACMEHost = cfg.domain;
            extraConfig = "reverse_proxy 127.0.0.1:${toString s.port}";
          }) proxied);
        };
        # No firewall change: 443 is reached over tailscale0, which `network` trusts.

        balaur.services = [{
          name = "Balaur on the web";
          description = "https://${cfg.domain}";
          icon = "🌐";
          unit = "caddy.service";
          group = "Network";
        }];
      };
    };
}
