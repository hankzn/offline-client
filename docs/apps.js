// docs/app.js —— 适配 ethers v6
// 仅在离线环境运行；依赖本地 libs/ethers.umd.min.js (v6) 与 libs/qrcode.min.js

(function(){
  const ZERO = "0x0000000000000000000000000000000000000000";

  // 小工具
  const $ = (id)=>document.getElementById(id);
  const byName = (name)=>document.querySelector(`[name="${name}"]:checked`);

  // 把 "123.456" + decimals(6) -> "123456000"（字符串），避免浮点误差
  function decimalToSmallestStr(amountStr, decimals) {
    if (!/^\d+(\.\d+)?$/.test(amountStr)) {
      throw new Error("amount（人类可读）格式不正确，应为非负小数，如 1 或 1.23");
    }
    const [intPart, fracPartRaw=""] = amountStr.split(".");
    const fracPart = fracPartRaw.padEnd(decimals, "0");
    if (fracPartRaw.length > decimals) {
      throw new Error(`小数位超过代币精度（decimals=${decimals}），请减少小数位或调整 decimals。`);
    }
    const s = (intPart + fracPart.slice(0, decimals)).replace(/^0+/, "") || "0";
    BigInt(s); // 校验
    return s;
  }

  const hexPad32 = (hex)=> {
    let h = hex.replace(/^0x/i,'').toLowerCase();
    if (h.length === 64) return "0x"+h;
    if (h.length > 64) throw new Error("nonce 超过 32 字节");
    return "0x" + h.padStart(64,'0');
  };
  const randomNonce = ()=> {
    const a = new Uint8Array(32); crypto.getRandomValues(a);
    return "0x" + Array.from(a).map(b=>b.toString(16).padStart(2,'0')).join('');
  };
  const saveBlob = (name, mime, data) => {
    const blob = new Blob([data], {type:mime});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  };

  // ========== 一、EIP-712 Payment Intent（含人类金额→最小单位自动换算 + 二维码显示） ==========
  const piPayee   = $("pi_payee");
  const piToken   = $("pi_token");
  const piAmtH    = $("pi_amount_human");
  const piDec     = $("pi_decimals");
  const piAmtS    = $("pi_amount_smallest");
  const piChain   = $("pi_chain");
  const piDeadline= $("pi_deadline");
  const piNonce   = $("pi_nonce");
  const piMemo    = $("pi_memo");
  const piPriv    = $("pi_priv");
  const btnCalc   = $("btn_calc_smallest");
  const btnSignIntent = $("btn_sign_intent");
  const btnSaveIntent = $("btn_save_intent");
  const btnSaveSig    = $("btn_save_sig");
  const outPI         = $("pi_out");

  // 当 token 为 0x0… 时，自动使用 18 并锁定 decimals
  function refreshDecimalsLock() {
    const t = piToken.value.trim();
    const isZero = /^0x0+$/i.test(t) || t === "";
    if (isZero) {
      piDec.value = "18";
      piDec.readOnly = true;
      piDec.classList.add("readonly");
    } else {
      piDec.readOnly = false;
      piDec.classList.remove("readonly");
    }
  }
  piToken.addEventListener("input", refreshDecimalsLock);
  refreshDecimalsLock();

  function recalcSmallest() {
    try{
      const human = (piAmtH.value || "").trim();
      const decimals = Math.max(0, Math.min(36, parseInt(piDec.value || "18", 10)));
      if (human === "") { piAmtS.value = ""; return; }
      const s = decimalToSmallestStr(human, decimals);
      piAmtS.value = s;
    }catch(e){
      piAmtS.value = `错误：${e.message}`;
    }
  }
  btnCalc.addEventListener("click", recalcSmallest);
  piAmtH.addEventListener("input", ()=>{});
  piDec.addEventListener("input", ()=>{});

  btnSignIntent.addEventListener('click', async () => {
    try{
      // 基本字段
      const payee    = piPayee.value.trim();
      const tokenIn  = piToken.value.trim();
      const token    = /^0x0+$/i.test(tokenIn) || tokenIn==="" ? ZERO : tokenIn;
      const chainId  = parseInt(piChain.value,10);
      const minutes  = parseInt(piDeadline.value,10);
      const deadline = Math.floor(Date.now()/1000) + minutes*60;
      const memo     = piMemo.value || "";
      const priv     = piPriv.value.trim();

      // 读取人类金额与 decimals，换算为最小单位整数
      const decimals = Math.max(0, Math.min(36, parseInt(piDec.value || "18", 10)));
      if (piAmtH.value.trim()==="") throw new Error("请填写 amount（人类可读，小数）。");
      const amountSmallestStr = decimalToSmallestStr(piAmtH.value.trim(), decimals);
      piAmtS.value = amountSmallestStr;

      // nonce
      let nonce      = piNonce.value.trim();
      if (!nonce) nonce = randomNonce();
      nonce = hexPad32(nonce);

      // 使用 payee 私钥签名（ethers v6）
      const wallet = new ethers.Wallet(priv);

      // TypedData
      const domain = {
        name: "PaymentIntent",
        version: "1",
        chainId,
        verifyingContract: ZERO
      };
      const types = {
        PaymentIntent: [
          {name:"payee", type:"address"},
          {name:"token", type:"address"},
          {name:"amount", type:"uint256"},
          {name:"chainId", type:"uint256"},
          {name:"deadline", type:"uint64"},
          {name:"nonce", type:"bytes32"},
          {name:"memo", type:"string"},
        ]
      };
      const value = {
        payee,
        token,
        amount: amountSmallestStr, // 最小单位整数
        chainId,
        deadline,
        nonce,
        memo
      };

      // v6：signTypedData
      const sig = await wallet.signTypedData(domain, types, value);

      // 渲染文本
      const intentMsg = JSON.stringify(value, null, 2);
      outPI.textContent =
        "Signer (payee): " + wallet.address + "\n" +
        "Intent (message):\n" + intentMsg + "\n\n" +
        "Signature (hex):\n" + sig + "\n";

      // 生成两个二维码（仅显示，不保存）
      const qi = $("qrcode_intent");
      const qs = $("qrcode_sig");
      qi.innerHTML = ""; qs.innerHTML = "";
      new QRCode(qi, { text: intentMsg, width: 220, height: 220,
        colorDark:"#000000", colorLight:"#ffffff", correctLevel: QRCode.CorrectLevel.M });
      new QRCode(qs, { text: sig, width: 220, height: 220,
        colorDark:"#000000", colorLight:"#ffffff", correctLevel: QRCode.CorrectLevel.M });

      // 允许保存文本文件（可选）
      btnSaveIntent.disabled = false;
      btnSaveSig.disabled = false;
      btnSaveIntent.onclick = ()=> saveBlob("intent.json", "application/json", intentMsg);
      btnSaveSig.onclick    = ()=> saveBlob("intent.sig", "text/plain", sig);

    }catch(e){
      outPI.textContent = "错误：" + e.message;
      $("qrcode_intent").innerHTML = "";
      $("qrcode_sig").innerHTML = "";
      btnSaveIntent.disabled = true;
      btnSaveSig.disabled = true;
    }
  });

  // ========== 二、EIP-1559 交易签名（保持已有：to 自动填充、金额/币种不可逆锁定、rawTx 二维码显示） ==========
  const kindRadios = document.getElementsByName("txkind");
  const txFrom = $("tx_from");
  const txPreview = $("tx_preview");
  const txOut = $("tx_out");
  const btnPreview = $("btn_preview");
  const btnSignTx = $("btn_sign_tx");
  const btnSaveRaw = $("btn_save_raw");
  const btnSaveHuman = $("btn_save_human");
  const btnFillToFromPI = $("btn_fill_to_from_pi");

  const btnLockAsset = $("btn_lock_asset");
  const lockBadge = $("lock_badge");
  let assetLocked = false; // 一旦 true，不可逆

  const uiSwitch = ()=>{
    const kind = byName("txkind").value;
    const show = (el,vis)=> el.classList[vis?'remove':'add']('hidden');
    $("tx_gas").value = (kind==="ETH") ? 21000 : 60000;
    show($("label_amount_eth"), kind==="ETH");
    show($("label_amount_erc"), kind!=="ETH");
    show($("label_token"), kind!=="ETH");
  };
  Array.from(kindRadios).forEach(r => r.addEventListener('change', ()=>{ if(!assetLocked) uiSwitch(); }));
  uiSwitch();

  const updateFrom = ()=>{
    try{
      const priv = $("tx_priv").value.trim();
      if (priv && /^0x[0-9a-fA-F]{64}$/.test(priv)){
        const w = new ethers.Wallet(priv);
        txFrom.value = w.address;
      } else {
        txFrom.value = "";
      }
    }catch{ txFrom.value = ""; }
  };
  $("tx_priv").addEventListener('input', updateFrom);

  btnFillToFromPI.addEventListener('click', ()=>{
    try{
      const piPriv = $("pi_priv").value.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(piPriv)) throw new Error("上方 payee 私钥缺失或格式不正确。");
      const w = new ethers.Wallet(piPriv);
      $("tx_to").value = w.address;
    }catch(e){
      alert("填入失败：" + e.message);
    }
  });

  btnLockAsset.addEventListener('click', ()=>{
    if (assetLocked) return;
    const kind = byName("txkind").value;
    const hasEthAmt = $("tx_amount_eth").value.trim() !== "";
    const hasErcAmt = $("tx_amount_small").value.trim() !== "";
    if (kind === "ETH" && !hasEthAmt){ alert("请先填写 ETH 金额再锁定。"); return; }
    if (kind === "ERC20"){
      if (!hasErcAmt){ alert("请先填写 ERC-20 金额（最小单位）再锁定。"); return; }
      if (!/^0x[0-9a-fA-F]{40}$/.test($("tx_token").value.trim())){ alert("请先填写合法的 token 合约地址再锁定。"); return; }
    }
    Array.from(kindRadios).forEach(r=> r.disabled = true);
    $("tx_amount_eth").readOnly = true; $("tx_amount_eth").disabled = (kind!=="ETH");
    $("tx_amount_small").readOnly = true; $("tx_amount_small").disabled = (kind==="ETH");
    $("tx_token").readOnly = true; if (kind!=="ETH") $("tx_token").disabled = false;

    assetLocked = true;
    btnLockAsset.disabled = true;
    lockBadge.classList.remove('hidden');
  });

  function buildTxHuman(){
    const kind = byName("txkind").value;
    const chainId = parseInt($("tx_chain").value,10);
    const nonce = parseInt($("tx_nonce").value,10);
    const gas = parseInt($("tx_gas").value,10);
    const from = txFrom.value.trim();

    if (!/^0x[0-9a-fA-F]{40}$/.test(from)) throw new Error("from 无效：检查私钥");

    if (kind === "ETH"){
      const to = $("tx_to").value.trim();
      const amountEth = $("tx_amount_eth").value || "0";
      const valueWei = ethers.parseUnits(amountEth, 18);
      return {
        kind, from, to, value_wei: valueWei.toString(),
        amount_eth: amountEth,
        data_hex: "0x",
        chainId, nonce, gas,
        maxFeePerGas_gwei: parseFloat($("tx_maxfee").value || "0"),
        maxPriorityFeePerGas_gwei: parseFloat($("tx_maxprio").value || "0")
      };
    } else {
      const token = $("tx_token").value.trim();
      const to = $("tx_to").value.trim();
      const amountSmall = $("tx_amount_small").value || "0";
      const iface = new ethers.Interface(["function transfer(address to, uint256 amount)"]);
      const data = iface.encodeFunctionData("transfer", [to, amountSmall]);
      return {
        kind, from,
        token, to,
        amount_smallest_unit: amountSmall,
        data_hex: data,
        value_wei: "0",
        chainId, nonce, gas,
        maxFeePerGas_gwei: parseFloat($("tx_maxfee").value || "0"),
        maxPriorityFeePerGas_gwei: parseFloat($("tx_maxprio").value || "0")
      };
    }
  }

  $("btn_preview").addEventListener('click', ()=>{
    try{
      const h = buildTxHuman();
      $("tx_preview").textContent = JSON.stringify(h, null, 2);
    }catch(e){
      $("tx_preview").textContent = "错误：" + e.message;
    }
  });

  $("btn_sign_tx").addEventListener('click', async ()=>{
    try{
      const h = buildTxHuman();
      const wallet = new ethers.Wallet($("tx_priv").value.trim());

      let tx;
      if (h.kind === "ETH"){
        tx = {
          type: 2,
          chainId: h.chainId,
          nonce: h.nonce,
          to: h.to,
          value: BigInt(h.value_wei),
          gasLimit: BigInt(h.gas),
          maxFeePerGas: ethers.parseUnits(String(h.maxFeePerGas_gwei), "gwei"),
          maxPriorityFeePerGas: ethers.parseUnits(String(h.maxPriorityFeePerGas_gwei), "gwei"),
          data: "0x",
        };
      } else {
        tx = {
          type: 2,
          chainId: h.chainId,
          nonce: h.nonce,
          to: h.token,        // ERC20 合约
          value: 0n,
          gasLimit: BigInt(h.gas),
          maxFeePerGas: ethers.parseUnits(String(h.maxFeePerGas_gwei), "gwei"),
          maxPriorityFeePerGas: ethers.parseUnits(String(h.maxPriorityFeePerGas_gwei), "gwei"),
          data: h.data_hex,
        };
      }

      const raw = await wallet.signTransaction(tx);
      const txhash = ethers.keccak256(raw);

      $("tx_out").textContent = "rawTx:\n" + raw + "\n\ntxHash:\n" + txhash + "\n";
      $("btn_save_raw").disabled = false;
      $("btn_save_human").disabled = false;

      // 生成 rawTx 二维码（仅显示，不保存）
      const qrDiv = document.getElementById("qrcode");
      qrDiv.innerHTML = "";
      new QRCode(qrDiv, {
        text: raw,
        width: 240, height: 240,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
      });

      $("btn_save_raw").onclick = ()=> saveBlob("rawtx.txt", "text/plain", raw);
      $("btn_save_human").onclick = ()=> {
        const human = (h.kind==="ETH") ? {
          kind: "ETH",
          from: h.from,
          to: h.to,
          value_wei: Number(h.value_wei),
          amount_eth: h.amount_eth,
          data_hex: "0x",
          chainId: h.chainId,
          nonce: h.nonce,
          gas: h.gas,
          maxFeePerGas_gwei: h.maxFeePerGas_gwei,
          maxPriorityFeePerGas_gwei: h.maxPriorityFeePerGas_gwei
        } : {
          kind: "ERC20",
          from: h.from,
          token: h.token,
          to: h.to,
          amount_smallest_unit: Number(h.amount_smallest_unit),
          data_hex: h.data_hex,
          value_wei: 0,
          chainId: h.chainId,
          nonce: h.nonce,
          gas: h.gas,
          maxFeePerGas_gwei: h.maxFeePerGas_gwei,
          maxPriorityFeePerGas_gwei: h.maxPriorityFeePerGas_gwei
        };
        saveBlob("tx_human.json","application/json", JSON.stringify(human, null, 2));
      };
    }catch(e){
      $("tx_out").textContent = "错误：" + e.message;
      $("btn_save_raw").disabled = true;
      $("btn_save_human").disabled = true;
      document.getElementById("qrcode").innerHTML = "";
    }
  });

})();
