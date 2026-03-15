import type { Logger } from '../utils/logger.js';

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitConfig {
  failureThreshold: number;   // failures before opening (default 5)
  resetTimeoutMs: number;     // time before trying half-open (default 60s)
  halfOpenMaxAttempts: number; // successful attempts to close (default 2)
}

interface BotCircuit {
  state: CircuitState;
  failures: number;
  lastFailure: number;
  halfOpenSuccesses: number;
}

export class CircuitBreaker {
  private circuits = new Map<string, BotCircuit>();
  private config: CircuitConfig;
  private logger: Logger;

  constructor(logger: Logger, config?: Partial<CircuitConfig>) {
    this.logger = logger.child({ module: 'circuit-breaker' });
    this.config = {
      failureThreshold: config?.failureThreshold ?? 5,
      resetTimeoutMs: config?.resetTimeoutMs ?? 60_000,
      halfOpenMaxAttempts: config?.halfOpenMaxAttempts ?? 2,
    };
  }

  private getCircuit(botName: string): BotCircuit {
    let circuit = this.circuits.get(botName);
    if (!circuit) {
      circuit = { state: 'closed', failures: 0, lastFailure: 0, halfOpenSuccesses: 0 };
      this.circuits.set(botName, circuit);
    }
    return circuit;
  }

  /** Check if a bot is available (circuit not open). */
  isAvailable(botName: string): boolean {
    const circuit = this.getCircuit(botName);
    if (circuit.state === 'closed') return true;
    if (circuit.state === 'open') {
      // Check if reset timeout has elapsed -> transition to half-open
      if (Date.now() - circuit.lastFailure >= this.config.resetTimeoutMs) {
        circuit.state = 'half-open';
        circuit.halfOpenSuccesses = 0;
        this.logger.info({ botName }, 'Circuit half-open, allowing probe request');
        return true;
      }
      return false;
    }
    // half-open: allow requests
    return true;
  }

  /** Record a successful execution. */
  recordSuccess(botName: string): void {
    const circuit = this.getCircuit(botName);
    if (circuit.state === 'half-open') {
      circuit.halfOpenSuccesses++;
      if (circuit.halfOpenSuccesses >= this.config.halfOpenMaxAttempts) {
        circuit.state = 'closed';
        circuit.failures = 0;
        this.logger.info({ botName }, 'Circuit closed (recovered)');
      }
    } else if (circuit.state === 'closed') {
      // Reset failure count on success
      circuit.failures = 0;
    }
  }

  /** Record a failed execution. */
  recordFailure(botName: string): void {
    const circuit = this.getCircuit(botName);
    circuit.failures++;
    circuit.lastFailure = Date.now();

    if (circuit.state === 'half-open') {
      // Failure during half-open -> back to open
      circuit.state = 'open';
      this.logger.warn({ botName, failures: circuit.failures }, 'Circuit re-opened (half-open probe failed)');
    } else if (circuit.failures >= this.config.failureThreshold) {
      circuit.state = 'open';
      this.logger.warn({ botName, failures: circuit.failures }, 'Circuit opened (threshold reached)');
    }
  }

  /** Get status for all circuits. */
  getStatus(): Record<string, { state: CircuitState; failures: number }> {
    const status: Record<string, { state: CircuitState; failures: number }> = {};
    for (const [name, circuit] of this.circuits) {
      status[name] = { state: circuit.state, failures: circuit.failures };
    }
    return status;
  }

  /** Reset a specific bot's circuit. */
  reset(botName: string): void {
    this.circuits.delete(botName);
    this.logger.info({ botName }, 'Circuit manually reset');
  }
}
