import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import abi from './CrowdfundingPlatform.json';

const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || '';

export default function App() {
  const [account, setAccount] = useState('');
  const [contractOwner, setContractOwner] = useState('');
  const [campaigns, setCampaigns] = useState([]);
  const [donationsMap, setDonationsMap] = useState({});
  const [expandedDonations, setExpandedDonations] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  // Form inputs
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [benefactor, setBenefactor] = useState('');
  const [goal, setGoal] = useState('');
  const [durationDays, setDurationDays] = useState('7');

  // Donation inputs per campaign ID
  const [donationAmounts, setDonationAmounts] = useState({});

  useEffect(() => {
    if (window.ethereum) {
      window.ethereum.on('accountsChanged', (accounts) => {
        if (accounts.length > 0) {
          setAccount(accounts[0]);
        } else {
          setAccount('');
        }
      });
    }
  }, []);

  useEffect(() => {
    fetchCampaigns();
  }, [account]);

  // Live updates listener for DonationReceived events
  useEffect(() => {
    if (!CONTRACT_ADDRESS || CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000') return;
    if (!window.ethereum) return;

    let activeContract;

    const setupDonationListener = async () => {
      try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        activeContract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);

        const onDonationReceived = (campaignId, donor, amount, eventPayload) => {
          const cId = Number(campaignId);
          const formattedAmount = ethers.formatEther(amount);
          const txHash = eventPayload?.log?.transactionHash || eventPayload?.transactionHash || '';

          const newDonation = {
            donor,
            amount: formattedAmount,
            txHash
          };

          setDonationsMap((prev) => ({
            ...prev,
            [cId]: [newDonation, ...(prev[cId] || [])]
          }));

          // Live update the campaign amountRaised in state
          setCampaigns((prevCampaigns) =>
            prevCampaigns.map((c) => {
              if (c.id === cId) {
                const updatedRaised = (Number(c.amountRaised) + Number(formattedAmount)).toString();
                return { ...c, amountRaised: updatedRaised };
              }
              return c;
            })
          );
        };

        activeContract.on('DonationReceived', onDonationReceived);
      } catch (err) {
        console.warn('Could not set up live donation listener:', err);
      }
    };

    setupDonationListener();

    return () => {
      if (activeContract) {
        activeContract.removeAllListeners('DonationReceived');
      }
    };
  }, []);

  async function getProviderOrSigner(needSigner = false) {
    if (!window.ethereum) {
      throw new Error('MetaMask is not installed in your browser.');
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    if (needSigner) {
      return await provider.getSigner();
    }
    return provider;
  }

  async function getContract(needSigner = false) {
    if (!CONTRACT_ADDRESS || CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000') {
      throw new Error('Contract address is not set in VITE_CONTRACT_ADDRESS.');
    }
    const runner = await getProviderOrSigner(needSigner);
    return new ethers.Contract(CONTRACT_ADDRESS, abi, runner);
  }

  async function connectWallet() {
    try {
      setError('');
      if (!window.ethereum) {
        setError('MetaMask extension not found. Please install MetaMask.');
        return;
      }
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      if (accounts.length > 0) {
        setAccount(accounts[0]);
        setInfo('Wallet connected!');
      }
    } catch (err) {
      setError(err.message || 'Failed to connect wallet');
    }
  }

  async function fetchCampaigns() {
    try {
      setError('');
      if (!CONTRACT_ADDRESS || CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000') {
        return;
      }
      const contract = await getContract(false);

      try {
        const ownerAddr = await contract.owner();
        setContractOwner(ownerAddr.toLowerCase());
      } catch (e) {
        console.warn('Could not fetch contract owner:', e);
      }

      // Query past DonationReceived events with RPC block range fallback
      let allDonationEvents = [];
      try {
        console.log(`[DEBUG] Fetching all DonationReceived events on contract...`);
        const genericFilter = contract.filters.DonationReceived();

        try {
          // Attempt 1: Query from block 0
          allDonationEvents = await contract.queryFilter(genericFilter, 0, 'latest');
        } catch (err0) {
          console.warn('[DEBUG] Query from block 0 failed (RPC range limit), trying recent block range fallback:', err0);
          try {
            const provider = contract.runner.provider || (await getProviderOrSigner(false));
            const currentBlock = await provider.getBlockNumber();
            const fromBlock = Math.max(0, currentBlock - 100000);
            allDonationEvents = await contract.queryFilter(genericFilter, fromBlock, 'latest');
          } catch (errFallback) {
            console.warn('[DEBUG] 100k block fallback failed, trying 10k blocks:', errFallback);
            const provider = contract.runner.provider || (await getProviderOrSigner(false));
            const currentBlock = await provider.getBlockNumber();
            const fromBlock = Math.max(0, currentBlock - 10000);
            allDonationEvents = await contract.queryFilter(genericFilter, fromBlock, 'latest');
          }
        }

        console.log(`[DEBUG] Total DonationReceived events returned from RPC:`, allDonationEvents.length, allDonationEvents);
      } catch (eventErr) {
        console.warn(`Error querying donation events:`, eventErr);
      }

      // Fetch campaign details
      const loadedCampaigns = [];
      const newDonationsMap = {};
      let campaignId = 1;
      let consecutiveErrors = 0;

      while (consecutiveErrors < 2 && campaignId <= 100) {
        try {
          const details = await contract.getCampaignDetails(campaignId);
          loadedCampaigns.push({
            id: campaignId,
            title: details[0],
            description: details[1],
            benefactor: details[2],
            goal: ethers.formatEther(details[3]),
            deadline: Number(details[4]),
            amountRaised: ethers.formatEther(details[5]),
            ended: details[6]
          });

          // Filter events for this campaignId safely
          const campaignEvents = allDonationEvents.filter((evt) => {
            if (!evt || !evt.args) return false;
            const rawId = evt.args.campaignId !== undefined ? evt.args.campaignId : evt.args[0];
            return Number(rawId) === campaignId;
          });

          newDonationsMap[campaignId] = campaignEvents.map((evt) => {
            const donorAddr = evt.args.donor !== undefined ? evt.args.donor : evt.args[1];
            const rawAmount = evt.args.amount !== undefined ? evt.args.amount : evt.args[2];
            return {
              donor: String(donorAddr),
              amount: ethers.formatEther(rawAmount),
              txHash: evt.transactionHash
            };
          }).reverse(); // Newest first

          consecutiveErrors = 0;
        } catch (err) {
          consecutiveErrors++;
        }
        campaignId++;
      }

      setCampaigns(loadedCampaigns);
      setDonationsMap(newDonationsMap);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleCreateCampaign(e) {
    e.preventDefault();
    try {
      setLoading(true);
      setError('');
      setInfo('Submitting transaction to create campaign...');

      const contract = await getContract(true);
      const goalWei = ethers.parseEther(goal);
      const durationSeconds = Math.floor(Number(durationDays) * 86400);
      const targetBenefactor = benefactor.trim() || account;

      const tx = await contract.createCampaign(
        title,
        description,
        targetBenefactor,
        goalWei,
        durationSeconds
      );
      await tx.wait();

      setInfo('Campaign created successfully!');
      setTitle('');
      setDescription('');
      setBenefactor('');
      setGoal('');
      setDurationDays('7');

      fetchCampaigns();
    } catch (err) {
      setError(err.reason || err.message || 'Error creating campaign');
    } finally {
      setLoading(false);
    }
  }

  async function handleDonate(campaignId) {
    const amount = donationAmounts[campaignId];
    if (!amount || Number(amount) <= 0) {
      setError('Please enter a valid ETH amount to donate.');
      return;
    }

    try {
      setLoading(true);
      setError('');
      setInfo(`Donating ${amount} ETH to Campaign #${campaignId}...`);

      const contract = await getContract(true);
      const tx = await contract.donateToCampaign(campaignId, {
        value: ethers.parseEther(amount)
      });
      await tx.wait();

      setInfo('Donation successful! Thank you.');
      setDonationAmounts((prev) => ({ ...prev, [campaignId]: '' }));
      fetchCampaigns();
    } catch (err) {
      setError(err.reason || err.message || 'Donation failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleEndCampaign(campaignId) {
    try {
      setLoading(true);
      setError('');
      setInfo(`Finalizing Campaign #${campaignId}...`);

      const contract = await getContract(true);
      const tx = await contract.endCampaign(campaignId);
      await tx.wait();

      setInfo('Campaign finalized successfully! Funds transferred to benefactor.');
      fetchCampaigns();
    } catch (err) {
      setError(err.reason || err.message || 'Ending campaign failed');
    } finally {
      setLoading(false);
    }
  }

  function toggleDonationsCollapse(campaignId) {
    setExpandedDonations((prev) => ({
      ...prev,
      [campaignId]: !prev[campaignId]
    }));
  }

  return (
    <div className="app-container">
      <header>
        <div>
          <h1 className="brand-title">Crowdfund Web3</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Zero-cost decentralized fundraising on Ethereum Sepolia
          </p>
        </div>

        {account ? (
          <span className="status-badge badge-connected">
            Connected: {account.substring(0, 6)}...{account.substring(account.length - 4)}
          </span>
        ) : (
          <button className="btn btn-primary" onClick={connectWallet}>
            Connect Wallet
          </button>
        )}
      </header>

      {error && <div className="alert-box alert-error">{error}</div>}
      {info && <div className="alert-box alert-info">{info}</div>}

      {!CONTRACT_ADDRESS || CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000' ? (
        <div className="glass-card" style={{ textAlign: 'center' }}>
          <h3>Contract Not Connected</h3>
          <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
            Deploy the contract on Sepolia, then set <code>VITE_CONTRACT_ADDRESS</code> in your <code>frontend/.env</code> file.
          </p>
        </div>
      ) : null}

      <div className="glass-card">
        <h2 className="card-title">Create New Campaign</h2>
        <form onSubmit={handleCreateCampaign}>
          <div className="form-grid">
            <div className="form-group">
              <label>Campaign Title</label>
              <input
                type="text"
                required
                placeholder="e.g. Save Open Source Library"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label>Goal (ETH)</label>
              <input
                type="number"
                step="0.001"
                required
                placeholder="0.1"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label>Duration (Days)</label>
              <input
                type="number"
                required
                min="1"
                value={durationDays}
                onChange={(e) => setDurationDays(e.target.value)}
              />
            </div>

            <div className="form-group full-width">
              <label>Benefactor Address (Defaults to your wallet if empty)</label>
              <input
                type="text"
                placeholder="0x..."
                value={benefactor}
                onChange={(e) => setBenefactor(e.target.value)}
              />
            </div>

            <div className="form-group full-width">
              <label>Description</label>
              <textarea
                rows="3"
                required
                placeholder="Explain why you are raising funds..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>

          <button className="btn btn-primary" type="submit" disabled={loading || !account}>
            {loading ? 'Processing...' : 'Create Campaign'}
          </button>
        </form>
      </div>

      <div>
        <h2 className="card-title" style={{ marginBottom: '1.5rem' }}>
          Active & Past Campaigns
        </h2>

        {campaigns.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No campaigns found on contract yet.</p>
        ) : (
          <div className="campaigns-grid">
            {campaigns.map((c) => {
              const nowSeconds = Math.floor(Date.now() / 1000);
              const isExpired = nowSeconds >= c.deadline;
              const isEnded = c.ended;
              const percent = Math.min(
                100,
                Math.round((Number(c.amountRaised) / (Number(c.goal) || 1)) * 100)
              );

              const userIsBenefactor = account && account.toLowerCase() === c.benefactor.toLowerCase();
              const userIsOwner = account && contractOwner && account.toLowerCase() === contractOwner;
              const donations = donationsMap[c.id] || [];
              const isExpanded = expandedDonations[c.id] !== false; // Default to open

              return (
                <div key={c.id} className="glass-card campaign-card">
                  <div>
                    <div className="campaign-header">
                      <span className="campaign-title">
                        #{c.id} {c.title}
                      </span>
                      <span className={`status-badge ${isEnded ? 'badge-ended' : 'badge-active'}`}>
                        {isEnded ? 'Ended' : isExpired ? 'Expired' : 'Active'}
                      </span>
                    </div>

                    <p className="campaign-desc">{c.description}</p>

                    <div className="meta-row">
                      <span>Raised: {c.amountRaised} ETH</span>
                      <span>Goal: {c.goal} ETH</span>
                    </div>

                    <div className="progress-bar-bg">
                      <div className="progress-bar-fill" style={{ width: `${percent}%` }}></div>
                    </div>

                    <div className="meta-row">
                      <span>Benefactor: {c.benefactor.substring(0, 6)}...{c.benefactor.substring(c.benefactor.length - 4)}</span>
                      <span>Deadline: {new Date(c.deadline * 1000).toLocaleDateString()}</span>
                    </div>
                  </div>

                  {!isEnded && !isExpired && (
                    <div className="action-row">
                      <input
                        type="number"
                        step="0.001"
                        placeholder="ETH"
                        value={donationAmounts[c.id] || ''}
                        onChange={(e) =>
                          setDonationAmounts({
                            ...donationAmounts,
                            [c.id]: e.target.value
                          })
                        }
                      />
                      <button
                        className="btn btn-success"
                        disabled={loading || !account}
                        onClick={() => handleDonate(c.id)}
                      >
                        Donate
                      </button>
                    </div>
                  )}

                  {!isEnded && (isExpired || Number(c.amountRaised) >= Number(c.goal)) && (userIsBenefactor || userIsOwner) && (
                    <div style={{ marginTop: '1rem' }}>
                      <button
                        className="btn btn-danger"
                        style={{ width: '100%' }}
                        disabled={loading}
                        onClick={() => handleEndCampaign(c.id)}
                      >
                        End Campaign & Claim Funds
                      </button>
                    </div>
                  )}

                  {/* Recent Donations Section */}
                  <div style={{ marginTop: '1.25rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-color)' }}>
                    <div
                      style={{
                        display: 'flex',
                        justify: 'space-between',
                        alignItems: 'center',
                        cursor: 'pointer',
                        userSelect: 'none'
                      }}
                      onClick={() => toggleDonationsCollapse(c.id)}
                    >
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                        Donations ({donations.length})
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {isExpanded ? '▲' : '▼'}
                      </span>
                    </div>

                    {isExpanded && (
                      <div style={{ marginTop: '0.5rem', maxHeight: '160px', overflowY: 'auto' }}>
                        {donations.length === 0 ? (
                          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic', margin: '0.25rem 0' }}>
                            No donations yet
                          </p>
                        ) : (
                          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                            {donations.map((d, idx) => (
                              <li
                                key={idx}
                                style={{
                                  display: 'flex',
                                  justify: 'space-between',
                                  alignItems: 'center',
                                  fontSize: '0.8rem',
                                  padding: '0.3rem 0',
                                  borderBottom: '1px dotted rgba(255, 255, 255, 0.08)'
                                }}
                              >
                                <span>
                                  {d.donor.substring(0, 6)}...{d.donor.substring(d.donor.length - 4)} — <strong>{d.amount} ETH</strong>
                                </span>
                                {d.txHash ? (
                                  <a
                                    href={`https://sepolia.etherscan.io/tx/${d.txHash}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: 500 }}
                                  >
                                    Tx ↗
                                  </a>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
