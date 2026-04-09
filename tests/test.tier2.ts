/**
 * Test Token Scanner with Tier 2 (Volume & Liquidity Analysis)
 */

import { getSolanaConnection } from '../src/core/connection';
import { TokenScanner } from '../src/scanner/token.scanner';
import { logger } from '../src/utils/logger';

// Known tokens for testing Tier 2
const TEST_TOKENS = {
  // Popular memecoins with good volume
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  POPCAT: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  // Add more tokens to test
};

async function main() {
  try {
    logger.info('='.repeat(60));
    logger.info('🧪 Testing Token Scanner - Tier 1 + Tier 2');
    logger.info('='.repeat(60));

    // Initialize connection
    logger.info('\n🔌 Connecting to Solana...');
    const connection = await getSolanaConnection();
    logger.success('Connected to Solana');

    // Initialize scanner
    logger.info('\n📡 Initializing token scanner...');
    const scanner = new TokenScanner(connection);
    logger.success('Scanner initialized');

    // Test tokens with Tier 2 analysis
    const tokenAddresses = Object.values(TEST_TOKENS);
    logger.info(`\n🔍 Scanning ${tokenAddresses.length} tokens with Tier 2 analysis...`);
    logger.info('This will fetch volume & liquidity data from APIs...\n');

    const candidates = await scanner.scanTokens(tokenAddresses, { includeTier2: true }); // Include Tier 2

    logger.info(`\n\n📊 SCAN RESULTS (TIER 1 + TIER 2)`);
    logger.info('='.repeat(60));
    logger.info(`Total scanned: ${tokenAddresses.length}`);
    logger.info(`Passed checks: ${candidates.length}`);
    logger.info(`Failed checks: ${tokenAddresses.length - candidates.length}`);

    if (candidates.length > 0) {
      logger.info('\n\n✅ CANDIDATES WITH TIER 2 ANALYSIS:');
      candidates.forEach((candidate, index) => {
        console.log(`\n[${index + 1}/${candidates.length}]`);
        scanner.printCandidateReport(candidate);
      });

      // Show top 3
      const top3 = scanner.getTopCandidates(candidates, 3);
      logger.info('\n\n🏆 TOP 3 CANDIDATES:');
      top3.forEach((candidate, index) => {
        const volumeInfo = candidate.volumeMetrics
          ? ` | Vol: $${candidate.volumeMetrics.volume24h.toLocaleString()}`
          : '';
        logger.info(`  ${index + 1}. ${candidate.symbol} - Score: ${candidate.score}/100 (Tier ${candidate.tier})${volumeInfo}`);
      });

      // Statistics
      logger.info('\n\n📈 TIER 2 STATISTICS:');
      const withVolume = candidates.filter(c => c.volumeMetrics);
      logger.info(`Tokens with volume data: ${withVolume.length}/${candidates.length}`);

      if (withVolume.length > 0) {
        const avgVolume = withVolume.reduce((sum, c) => sum + (c.volumeMetrics?.volume24h || 0), 0) / withVolume.length;
        const avgLiquidity = withVolume.reduce((sum, c) => sum + (c.volumeMetrics?.liquidity || 0), 0) / withVolume.length;

        logger.info(`Average 24h Volume: $${avgVolume.toLocaleString()}`);
        logger.info(`Average Liquidity: $${avgLiquidity.toLocaleString()}`);

        const tier2Passed = withVolume.filter(c => c.volumeMetrics?.passed).length;
        logger.info(`Tier 2 Pass Rate: ${tier2Passed}/${withVolume.length} (${((tier2Passed / withVolume.length) * 100).toFixed(1)}%)`);
      }
    } else {
      logger.warn('\n❌ No candidates passed safety checks');
    }

    logger.info('\n' + '='.repeat(60));
    logger.success('✅ Tier 2 scanner test completed');
    logger.info('='.repeat(60));

  } catch (error) {
    logger.error('Test failed', error);
    process.exit(1);
  }
}

// Run test
if (require.main === module) {
  main()
    .then(() => {
      logger.info('\n👋 Test completed');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Test error', error);
      process.exit(1);
    });
}

export default main;
