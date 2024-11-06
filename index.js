#!/usr/bin/env node

import axios from "axios";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import os from "os";
import { Table } from "console-table-printer";
import ora from "ora";
import chalk from "chalk";
import clear from "clear";
import { format } from "date-fns";

class StockMonitor {
  constructor() {
    this.configDir = path.join(os.homedir(), ".stock-monitor");
    this.configFile = path.join(this.configDir, "config.json");
    this.portfolioFile = path.join(this.configDir, "portfolio.json");
    this.lastPrices = new Map();
    this.apiClient = axios.create({
      baseURL: "http://api.tushare.pro",
      timeout: 10000,
      headers: {
        "Content-Type": "application/json",
      },
    });
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
    // Format: 600000 -> 600000.SH, 000001 -> 000001.SZ
    if (symbol.includes(".")) return symbol;
    if (symbol.startsWith("6")) {
      return `${symbol}.SH`;
    } else if (symbol.startsWith("0") || symbol.startsWith("3")) {
      return `${symbol}.SZ`;
    }
    return symbol;
  }

  getCurrentDate() {
    return format(new Date(), "yyyyMMdd");
  }

  async getStockData(symbol) {
    try {
      // 在獲取股票數據前重新加載配置
      await this.loadPortfolio();
      
      const formattedSymbol = this.formatStockCode(symbol);
      const response = await this.apiClient.post("/", {
        api_name: "daily",
        token: this.config.apiKey,
        params: {
          ts_code: formattedSymbol,
          trade_date: this.getCurrentDate(),
        },
        fields:
          "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount",
      });

      if (response.data?.data?.items?.[0]) {
        const [
          ts_code,
          trade_date,
          open,
          high,
          low,
          close,
          pre_close,
          change,
          pct_chg,
        ] = response.data.data.items[0];

        return {
          symbol: ts_code,
          date: trade_date,
          open,
          high,
          low,
          close,
          preClose: pre_close,
          change,
          changePercent: pct_chg,
        };
      }
      throw new Error("No data available");
    } catch (error) {
      console.error(`Error fetching ${symbol}: ${error.message}`);
      return null;
    }
  }

  async addPosition(symbol, shares, purchasePrice, name = '') {
    const formattedSymbol = this.formatStockCode(symbol);
    const existingPosition = this.portfolio.find(
      (p) => p.symbol === formattedSymbol
    );

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
      const position = {
        symbol: formattedSymbol,
        name,  // 增加名稱字段
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
          name: position.name || '',  // 增加名稱字段
          shares: position.shares,
          purchasePrice: position.purchasePrice.toFixed(2),
          currentPrice: currentPrice.toFixed(2),
          todayChange: `${data.changePercent.toFixed(2)}%`,  // 添加今日漲跌幅
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
        spinner.text = `Monitoring stocks... (Update #${++updateCount})`;

        const result = await this.calculatePortfolio();
        spinner.stop();

        console.log(
          chalk.cyan(`Last update: ${new Date().toLocaleString()}\n`)
        );

        const table = new Table({
          columns: [
            { name: "symbol", alignment: "left" },
            { name: "name", title: "Name", alignment: "left" },  // 增加名稱列
            { name: "shares", alignment: "right" },
            { name: "purchasePrice", title: "Buy Price", alignment: "right" },
            { name: "currentPrice", title: "Current", alignment: "right" },
            { name: "todayChange", title: "Today%", alignment: "right" },  // 新增今日漲跌列
            { name: "value", alignment: "right" },
            { name: "profit", alignment: "right" },
            { name: "return", title: "Total%", alignment: "right" },
          ],
        });

        result.positions.forEach((position) => {
          const row = { ...position };
          // 為今日漲跌幅添加顏色
          const todayChangeValue = parseFloat(position.todayChange);
          row.todayChange = todayChangeValue >= 0
            ? chalk.green(position.todayChange)
            : chalk.red(position.todayChange);
          // 為總收益率添加顏色
          const returnValue = parseFloat(position.return);
          row.return = returnValue >= 0
            ? chalk.green(position.return)
            : chalk.red(position.return);
          table.addRow(row);
        });

        table.printTable();

        console.log(chalk.bold("\nPortfolio Summary:"));
        console.log(
          `Total Value: ${chalk.yellow("¥" + result.summary.totalValue)}`
        );
        console.log(
          `Total Cost: ${chalk.yellow("¥" + result.summary.totalCost)}`
        );
        console.log(
          `Total Profit: ${
            parseFloat(result.summary.totalProfit) >= 0
              ? chalk.green("¥" + result.summary.totalProfit)
              : chalk.red("¥" + result.summary.totalProfit)
          }`
        );
        console.log(
          `Total Return: ${
            parseFloat(result.summary.totalReturn) >= 0
              ? chalk.green(result.summary.totalReturn + "%")
              : chalk.red(result.summary.totalReturn + "%")
          }`
        );

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
    const table = new Table();
    result.positions.forEach((r) => table.addRow(r));
    table.printTable();
  }
}

// CLI Setup
async function setupCLI() {
  const monitor = new StockMonitor();
  await monitor.initialize();

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
          describe: "Stock symbol (e.g., 600000 for Shanghai, 000001 for Shenzhen)",
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
        name: {  // 增加名稱參數
          alias: "t",
          describe: "Stock name (optional)",
          type: "string",
          default: '',
        },
      },
      async (argv) => {
        await monitor.addPosition(argv.symbol, argv.shares, argv.price, argv.name);
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
    .completion()  // 啟用 yargs 內建的自動補全功能
    .help()
    .alias("help", "h")
    .parse();
}

// Start the application
setupCLI().catch(console.error);
