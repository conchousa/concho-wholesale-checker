# The six channels tracked in the Active Channels licensing sheet.
TRACKED_CHANNELS = ["RRET", "SMT", "SGSS", "BDPT", "CAMP", "GLFS"]

# Friendly names for CLC retailer types. These are working labels based on the
# kinds of stores filed under each code. Edit them to match CLC's official
# wording; the codes are what the checker actually uses.
CHANNEL_LABELS = {
    "BDPT": "Boutique",
    "CAMP": "Campus & local",
    "GLFS": "Golf shop",
    "RRET": "Retail / online retail",
    "SGSS": "Sporting goods & team stores",
    "SMT": "Specialty market",
    "SMC": "Specialty market (other)",
    "GDC": "Grocery, drug & convenience",
    "ITC": "Internet, TV & catalog",
    "REST": "Restricted / university internal",
    "AMP": "Amusement & attractions",
    "OPC": "Off-price",
    "DPT": "Department store",
    "SCWC": "Supercenter & warehouse club",
    "TDLR": "Team dealer",
}
