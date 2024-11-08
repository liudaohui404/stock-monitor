#!/usr/bin/env node

import axios from "axios";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import path from "path";
import fs from "fs/promises";
import os from "os";
// import { Table } from "console-table-printer";
import ora from "ora";
import chalk from "chalk";
import clear from "clear";
import { format } from "date-fns";
import boxen from 'boxen';
import Table from 'cli-table3';
import gradient from 'gradient-string';

class StockMonitor {
  constructor() {
    this.configDir = path.join(os.homedir(), ".stock-monitor");
    this.configFile = path.join(this.configDir, "config.json");
    this.portfolioFile = path.join(this.configDir, "portfolio.json");
    this.lastPrices = new Map();
    this.lastTotalReturn = null;
  }

  async initialize() {
    try {
      await fs.mkdir(this.configDir, { recursive: true });
      await this.loadConfig();
      await this.loadPortfolio();
    } catch (error) {
      console.error("Error initializing:", error.message);
    }
  }

  async loadConfig() {
    try {
      const config = await fs.readFile(this.configFile, "utf8");
      this.config = JSON.parse(config);
    } catch (error) {
      this.config = { apiKey: "" };
      await this.saveConfig();
    }
  }

  async saveConfig() {
    await fs.writeFile(this.configFile, JSON.stringify(this.config, null, 2));
  }

  async loadPortfolio() {
    try {
      const portfolio = await fs.readFile(this.portfolioFile, "utf8");
      this.portfolio = JSON.parse(portfolio);
    } catch (error) {
      this.portfolio = [];
      await this.savePortfolio();
    }
  }

  async savePortfolio() {
    await fs.writeFile(
      this.portfolioFile,
      JSON.stringify(this.portfolio, null, 2)
    );
  }

  formatStockCode(symbol) {
    // Format for Tencent API: 600000 -> sh600000, 000001 -> sz000001
    if (symbol.includes(".")) {
      const [code, market] = symbol.split(".");
      return (market.toLowerCase() + code);
    }
    if (symbol.startsWith("6")) {
      return `sh${symbol}`;
    } else if (symbol.startsWith("0") || symbol.startsWith("3")) {
      return `sz${symbol}`;
    }
    return symbol;
  }

  getCurrentDate() {
    return format(new Date(), "yyyyMMdd");
  }

  async getStockData(symbol) {
    try {
      await this.loadPortfolio();
      const formattedSymbol = this.formatStockCode(symbol);
      const response = await axios.get(`https://qt.gtimg.cn/q=${formattedSymbol}`);
      
      if (response.data) {
        // Parse Tencent API response format
        // v_sh600000="1~浦发银行~600000~19.200~19.160~19.200~262258~130768~131490~19.190~98~19.180~404~19.170~236~19.160~456~19.150~351~19.200~518~19.210~454~19.220~194~19.230~122~19.240~276~~20230915155914~-0.040~-0.21~19.340~19.020~19.160/262258/502932531~262258~50293~0.83~18.39~~19.340~19.020~1.67~1055.57~1055.57~0.72~20.90~17.24~0.91~-42~19.199~19.199~19.199~6.37~6.37~-10.87~19.160~0.00~0.00~~~1.67~50293.25~0.00~0~0~0.00~0~0~0.83~0~GP-A~81~";
        const data = response.data.split('~');
        
        return {
          symbol: formattedSymbol,
          date: format(new Date(), 'yyyyMMdd'),
          open: parseFloat(data[5]),
          high: parseFloat(data[33]),
          low: parseFloat(data[34]),
          close: parseFloat(data[3]),
          preClose: parseFloat(data[4]),
          change: parseFloat(data[31]),
          changePercent: parseFloat(data[32])
        };
      }
      throw new Error("No data available");
    } catch (error) {
      console.error(`Error fetching ${symbol}: ${error.message}`);
      return null;
    }
  }

  async addPosition(symbol, shares, purchasePrice, name = "") {
    const formattedSymbol = this.formatStockCode(symbol);
    const existingPosition = this.portfolio.find(
      (p) => p.symbol === formattedSymbol
    );
    let position;
    if (existingPosition) {
      // 計算新的總成本和總股數
      const totalOldCost =
        existingPosition.shares * existingPosition.purchasePrice;
      const totalNewCost = shares * purchasePrice;
      const totalShares = existingPosition.shares + shares;

      // 計算新的平均購買價格
      const averagePrice = (totalOldCost + totalNewCost) / totalShares;

      // 更新現有持倉
      existingPosition.shares = totalShares;
      existingPosition.purchasePrice = averagePrice;
      existingPosition.dateModified = new Date().toISOString();
      // 如果提供了新的名稱，則更新
      if (name) {
        existingPosition.name = name;
      }
    } else {
      // 添加新持倉
      position = {
        symbol: formattedSymbol,
        name, // 增加名稱字段
        shares,
        purchasePrice,
        dateAdded: new Date().toISOString(),
      };
      this.portfolio.push(position);
    }

    await this.savePortfolio();
    return existingPosition || position;
  }

  async removePosition(symbol) {
    const position = this.portfolio.find(
      (p) => p.name === symbol || p.symbol === symbol
    );
    if (!position) {
      console.error("Position not found");
      return;
    }
    const formattedSymbol = this.formatStockCode(symbol);
    this.portfolio = this.portfolio.filter((p) => p.symbol !== formattedSymbol);
    await this.savePortfolio();
  }

  async calculatePortfolio() {
    const results = [];
    let totalValue = 0;
    let totalCost = 0;

    for (const position of this.portfolio) {
      const data = await this.getStockData(position.symbol);
      if (data) {
        const currentPrice = data.close;
        const cost = position.shares * position.purchasePrice;
        const value = position.shares * currentPrice;
        const profit = value - cost;
        const returnPct = (profit / cost) * 100;

        totalValue += value;
        totalCost += cost;

        results.push({
          symbol: position.symbol,
          name: position.name || "", // 增加名稱字段
          shares: position.shares,
          purchasePrice: position.purchasePrice.toFixed(2),
          currentPrice: currentPrice.toFixed(2),
          todayChange: `${data.changePercent.toFixed(2)}%`, // 添加今日漲跌幅
          value: value.toFixed(2),
          profit: profit.toFixed(2),
          return: `${returnPct.toFixed(2)}%`,
        });
      }
    }

    return {
      positions: results,
      summary: {
        totalValue: totalValue.toFixed(2),
        totalCost: totalCost.toFixed(2),
        totalProfit: (totalValue - totalCost).toFixed(2),
        totalReturn: (((totalValue - totalCost) / totalCost) * 100).toFixed(2),
      },
    };
  }

  async startMonitoring(interval = 20000) {
    const spinner = ora("Monitoring stocks...").start();
    let updateCount = 0;
    let lastUpdateTime = Date.now();

    const updateDisplay = async () => {
      try {
        const now = Date.now();
        if (now - lastUpdateTime < 1000) {
          return; // Rate limiting
        }
        lastUpdateTime = now;

        clear();
        const result = await this.calculatePortfolio();
        spinner.stop();

        // Create header
        console.log(boxen(
          gradient.rainbow(`Stock Portfolio Monitor - Update #${updateCount}`),
          {
            padding: 1,
            margin: 1,
            borderStyle: 'double',
            textAlignment: 'center'
          }
        ));

        // Create main table
        const table = new Table({
          head: ['Symbol', 'Name', 'Shares', 'Buy Price', 'Current', 'Today%', 'Value', 'Profit', 'Total%'].map(h => chalk.bold.white(h)),
          chars: {
            'top': '═', 'top-mid': '╤', 'top-left': '╔', 'top-right': '╗',
            'bottom': '═', 'bottom-mid': '╧', 'bottom-left': '╚', 'bottom-right': '╝',
            'left': '║', 'left-mid': '╟', 'right': '║', 'right-mid': '╢',
            'mid': '─', 'mid-mid': '┼', 'middle': '│'
          },
          style: {
            head: [], 
            border: []
          }
        });

        // Add position rows
        result.positions.forEach((position) => {
          const todayChangeValue = parseFloat(position.todayChange);
          const returnValue = parseFloat(position.return);
          
          table.push([
            position.symbol,
            position.name || '',
            position.shares.toString(),
            position.purchasePrice,
            position.currentPrice,
            todayChangeValue >= 0 ? chalk.red(position.todayChange) : chalk.green(position.todayChange),
            `¥${position.value}`,
            parseFloat(position.profit) >= 0 ? chalk.red(`¥${position.profit}`) : chalk.green(`¥${position.profit}`),
            returnValue >= 0 ? chalk.red(position.return) : chalk.green(position.return)
          ]);
        });

        // Add summary row with special formatting
        const currentTotalReturn = parseFloat(result.summary.totalReturn);
        let returnChange = '';
        if (this.lastTotalReturn !== null) {
          const change = currentTotalReturn - this.lastTotalReturn;
          returnChange = ` (${change >= 0 ? '↑' : '↓'} ${Math.abs(change).toFixed(2)}%)`;
        }
        this.lastTotalReturn = currentTotalReturn;

        table.push([
          chalk.bold('TOTAL'),
          '', '', '', '',
          '',
          chalk.yellow(`¥${result.summary.totalValue}`),
          parseFloat(result.summary.totalProfit) >= 0 
            ? chalk.red(`¥${result.summary.totalProfit}`)
            : chalk.green(`¥${result.summary.totalProfit}`),
          currentTotalReturn >= 0
            ? chalk.red(result.summary.totalReturn + "%" + returnChange)
            : chalk.green(result.summary.totalReturn + "%" + returnChange)
        ]);

        console.log(table.toString());

        // Add market status box
        console.log(boxen(
          `Last Update: ${new Date().toLocaleString()}`,
          {
            padding: 1,
            margin: 1,
            borderStyle: 'round',
            borderColor: 'cyan',
            textAlignment: 'center'
          }
        ));

        spinner.start();
      } catch (error) {
        console.error("Error updating display:", error);
      }
    };

    await updateDisplay();
    const intervalId = setInterval(updateDisplay, interval);

    process.on("SIGINT", () => {
      clearInterval(intervalId);
      spinner.stop();
      console.log("\nMonitoring stopped");
      process.exit(0);
    });
  }

  async displayPortfolio() {
    const result = await this.calculatePortfolio();
    const cliTable = new Table({
      head: ['Symbol', 'Name', 'Shares', 'Buy Price', 'Current', 'Today%', 'Value', 'Profit', 'Total%'],
    });

    result.positions.forEach((position) => {
      const todayChangeValue = parseFloat(position.todayChange);
      const returnValue = parseFloat(position.return);

      cliTable.push([
      position.symbol,
      position.name || '',
      position.shares.toString(),
      position.purchasePrice,
      position.currentPrice,
      todayChangeValue >= 0 ? chalk.red(position.todayChange) : chalk.green(position.todayChange),
      `¥${position.value}`,
      parseFloat(position.profit) >= 0 ? chalk.red(`¥${position.profit}`) : chalk.green(`¥${position.profit}`),
      returnValue >= 0 ? chalk.red(position.return) : chalk.green(position.return)
      ]);
    });

    console.log(cliTable.toString());
  }

  async getPortfolioSymbols() {
    await this.loadPortfolio();
    return this.portfolio.map((position) => ({
      name: `${position.symbol} (${position.name || "No Name"})`,
      value: position.symbol,
    }));
  }
}

// CLI Setup
async function setupCLI() {
  const monitor = new StockMonitor();
  await monitor.initialize();

  const symbols = await monitor.getPortfolioSymbols();

  yargs(hideBin(process.argv))
    .command(
      "config",
      "Configure API token",
      {
        key: {
          describe: "Your TuShare API token",
          type: "string",
          demandOption: true,
        },
      },
      async (argv) => {
        monitor.config.apiKey = argv.key;
        await monitor.saveConfig();
        console.log("API token saved successfully");
      }
    )
    .command(
      "add",
      "Add a new stock position",
      {
        symbol: {
          alias: "s",
          describe:
            "Stock symbol (e.g., 600000 for Shanghai, 000001 for Shenzhen)",
          type: "string",
          demandOption: true,
        },
        shares: {
          alias: "n",
          describe: "Number of shares",
          type: "number",
          demandOption: true,
        },
        price: {
          alias: "p",
          describe: "Purchase price per share",
          type: "number",
          demandOption: true,
        },
        name: {
          // 增加名稱參數
          alias: "t",
          describe: "Stock name (optional)",
          type: "string",
          default: "",
        },
      },
      async (argv) => {
        await monitor.addPosition(
          argv.symbol,
          argv.shares,
          argv.price,
          argv.name
        );
        console.log("Position added successfully");
      }
    )
    .command(
      "remove",
      "Remove a stock position",
      {
        symbol: {
          alias: "s",
          describe: "Stock symbol to remove",
          type: "string",
          demandOption: true,
          choices: symbols, // Use the symbols for tab completion
        },
      },
      async (argv) => {
        await monitor.removePosition(argv.symbol);
        console.log("Position removed successfully");
      }
    )
    .command(
      "monitor",
      "Start monitoring portfolio",
      {
        interval: {
          alias: "i",
          describe: "Update interval in seconds",
          type: "number",
          default: 20,
        },
      },
      async (argv) => {
        await monitor.startMonitoring(argv.interval * 1000);
      }
    )
    .command("view", "View portfolio", {}, async () => {
      await monitor.displayPortfolio();
    })
    .completion() // 啟用 yargs 內建的自動補全功能
    .help()
    .alias("help", "h")
    .parse();
}

// Start the application
setupCLI().catch(console.error);
