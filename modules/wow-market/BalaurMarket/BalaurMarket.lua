-- Balaur Market: the game's own vendor prices, for WoW Market (modules/wow-market.nix).
--
-- Forever changes some vendor prices from Blizzard's servers, after the game tables
-- that WoW Market downloads were made, so those tables can be wrong (an Iron Grenade:
-- 5s in the table, 1s 25c in the game). The game knows the real price: this asks it
-- for every item Auctionator has a price for, and every item in the bags, and keeps
-- the answers in BALAUR_MARKET.sell, which the game writes to disk on /reload or
-- logout. It only reads item information, as a tooltip does.
--
-- Items the game has not loaded yet are requested and asked again when they arrive,
-- a batch at a time so a few thousand of them never cost a frame.

BALAUR_MARKET = BALAUR_MARKET or {}

local GetItemInfo = GetItemInfo or (C_Item and C_Item.GetItemInfo)
local RequestLoad = C_Item and C_Item.RequestLoadItemDataByID
local GetBagSlots = (C_Container and C_Container.GetContainerNumSlots) or GetContainerNumSlots
local GetBagItemID = (C_Container and C_Container.GetContainerItemID) or GetContainerItemID

local BATCH = 50 -- items asked per tick
local TICK = 0.2 -- seconds between ticks

local queue, queued = {}, {}
local ticker

local function want(id)
  if id and not queued[id] then
    queued[id] = true
    queue[#queue + 1] = id
  end
end

local function record(id)
  local name, _, _, _, _, _, _, _, _, _, sellPrice = GetItemInfo(id)
  if name and sellPrice then
    BALAUR_MARKET.sell[id] = sellPrice
    return true
  end
  return false
end

local function tick()
  local n = 0
  while n < BATCH and #queue > 0 do
    local id = table.remove(queue)
    if not record(id) and RequestLoad then
      -- Asked for; GET_ITEM_INFO_RECEIVED records it when it arrives.
      pcall(RequestLoad, id)
    end
    n = n + 1
  end
  if #queue == 0 and ticker then
    ticker:Cancel()
    ticker = nil
  end
end

local function collect()
  BALAUR_MARKET.sell = BALAUR_MARKET.sell or {}
  BALAUR_MARKET.build = select(4, GetBuildInfo())
  BALAUR_MARKET.updated = time()
  -- Every realm Auctionator keeps prices for (after it loaded, they are tables).
  for _, realm in pairs(AUCTIONATOR_PRICE_DATABASE or {}) do
    if type(realm) == "table" then
      for key in pairs(realm) do
        want(tonumber(key))
      end
    end
  end
  for bag = 0, 4 do
    for slot = 1, (GetBagSlots(bag) or 0) do
      want(GetBagItemID(bag, slot))
    end
  end
  -- Asked again next time: a price can change with a patch.
  queued = {}
  if not ticker and #queue > 0 then
    ticker = C_Timer.NewTicker(TICK, tick)
  end
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("AUCTION_HOUSE_CLOSED")
frame:RegisterEvent("GET_ITEM_INFO_RECEIVED")
frame:SetScript("OnEvent", function(_, event, id, success)
  if event == "GET_ITEM_INFO_RECEIVED" then
    if success and BALAUR_MARKET.sell then
      record(id)
    end
  else
    -- After a scan the database holds new items; at login, Auctionator has just loaded.
    C_Timer.After(5, collect)
  end
end)
