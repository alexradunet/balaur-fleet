# balaur-verify-commit SIGNERS REMOTE REV REPO: is the commit REV of the repository
# at REMOTE signed by one of the keys in SIGNERS (git's allowed-signers format)?
# It fetches that one commit into the bare repository REPO (made when missing) and
# lets git check its SSH signature. Exit 0 only for a good signature by a listed
# key; an unsigned commit, another key's signature and a commit that cannot be
# fetched all fail. auto-deploy asks it before switching (modules/auto-deploy.nix).
{
  writeShellApplication,
  gitMinimal,
  openssh,
  coreutils,
}:
writeShellApplication {
  name = "balaur-verify-commit";
  runtimeInputs = [
    gitMinimal
    openssh # ssh-keygen checks the signature
    coreutils
  ];
  text = ''
    if [ $# -ne 4 ]; then
      echo "usage: balaur-verify-commit SIGNERS REMOTE REV REPO" >&2
      exit 2
    fi
    signers=$1 remote=$2 rev=$3 repo=$4
    # Nothing of the caller's or the machine's git configuration decides this.
    export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
    if [ ! -f "$repo/HEAD" ]; then
      git init -q --bare "$repo"
    fi
    if ! timeout 120 git -C "$repo" fetch -q --depth 1 "$remote" "$rev"; then
      echo "balaur-verify-commit: could not fetch $rev from $remote" >&2
      exit 1
    fi
    git -C "$repo" -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$signers" verify-commit "$rev"
  '';
}
