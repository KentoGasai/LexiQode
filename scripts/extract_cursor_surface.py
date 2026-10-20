import json, os, glob, collections
app = os.path.join(os.environ["LOCALAPPDATA"], "Programs", "cursor", "resources", "app")
ext_dir = os.path.join(app, "extensions")
out = {}
command_families = collections.Counter()
for path in sorted(glob.glob(os.path.join(ext_dir, "cursor*", "package.json"))):
    name = os.path.basename(os.path.dirname(path))
    try:
        pkg = json.load(open(path, encoding="utf-8"))
    except Exception as exc:
        out[name] = {"error": str(exc)}
        continue
    c = pkg.get("contributes") or {}
    cmds = [x.get("command") for x in (c.get("commands") or []) if isinstance(x, dict)]
    for cid in cmds:
        if cid:
            command_families[cid.split(".")[0]] += 1
    cfg = c.get("configuration")
    keys = []
    if isinstance(cfg, dict):
        keys = list((cfg.get("properties") or {}).keys())
    elif isinstance(cfg, list):
        for part in cfg:
            keys += list(((part or {}).get("properties") or {}).keys())
    out[name] = {
        "version": pkg.get("version"),
        "main": pkg.get("main"),
        "activationEvents": len(pkg.get("activationEvents") or []),
        "commands": cmds,
        "config_keys": keys,
        "views": sorted((c.get("views") or {}).keys()),
        "extra_contributes": sorted(k for k in c if k not in {"commands", "configuration", "views"}),
        "has_mcp": json.dumps(pkg).lower().count("mcp"),
    }
dest = os.path.join("F:\\Gitea\\LexiQode2\\docs\\cursor", "cursor-surface.json")
os.makedirs(os.path.dirname(dest), exist_ok=True)
json.dump({"extensions": out, "command_families": dict(command_families)}, open(dest, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
print("extensions with manifests:", len(out))
print("command families:", dict(command_families.most_common(12)))
for name, data in out.items():
    if "error" in data:
        print(" ", name, "ERROR", data["error"][:60]); continue
    print(f"  {name:32} v{data['version']:<10} cmds={len(data['commands']):<5} cfg={len(data['config_keys']):<5} acts={data['activationEvents']:<3} extra={data['extra_contributes'][:6]}")
